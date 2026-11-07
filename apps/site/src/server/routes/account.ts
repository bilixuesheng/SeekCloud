import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq } from "drizzle-orm";
import { confirmDeletion, sendDeletionCode } from "../account/deletion";
import {
  downloadableExport,
  EXPORT_INTERVAL_MS,
  type ExportRow,
  exportOverview,
  requestExport,
} from "../account/exports";
import type { AppDeps } from "../app";
import {
  checkNewEmail,
  confirmEmailChange,
  emailChangeErrors,
  sendEmailChangeCode,
} from "../auth/email-change";
import { currentUser, forgetLoginCookie } from "../auth/login-sessions";
import { githubTokens, identities } from "../db/schema";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { HOUR, MINUTE, type RateLimiter, tooFrequent } from "../rate-limit";
import type { Sessions } from "../sessions/sessions";
import { Email } from "./auth";
import { jsonBody as json, newRouter } from "./router";

const Provider = z.enum(["github"]);

const Code = z.string().regex(/^\d{6}$/, { error: "验证码为 6 位数字" });

const identitiesRoute = createRoute({
  method: "get",
  path: "/identities",
  summary: "账户的邮箱和绑定的第三方账号",
  responses: {
    200: {
      description: "登录方式",
      ...json(
        z.object({
          email: z.string(),
          identities: z.array(z.object({ provider: Provider, login: z.string() })),
        }),
      ),
    },
    401: errorResponse("没有登录"),
  },
});

const unlinkRoute = createRoute({
  method: "post",
  path: "/identities/unlink",
  summary: "解绑第三方账号",
  description:
    "邮箱验证码登录一直可用，所以第三方账号都能解绑，账户不会登不进去。解绑 GitHub 时一起删掉 GitHub 令牌。",
  request: { body: json(z.object({ provider: Provider })) },
  responses: {
    204: { description: "已解绑" },
    401: errorResponse("没有登录"),
    404: errorResponse("没有绑定这种账号"),
  },
});

const sendCodeRoute = createRoute({
  method: "post",
  path: "/email/send-code",
  summary: "换邮箱：给新邮箱发验证码",
  request: { body: json(z.object({ email: Email })) },
  responses: {
    204: { description: "已发送" },
    400: errorResponse("新邮箱和现在的一样"),
    401: errorResponse("没有登录"),
    409: errorResponse("新邮箱已经是别的账户的"),
    429: errorResponse("操作太频繁"),
  },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/email/confirm",
  summary: "换邮箱：填新邮箱收到的验证码，确认更换",
  request: { body: json(z.object({ code: Code })) },
  responses: {
    200: { description: "已更换", ...json(z.object({ email: z.string() })) },
    400: errorResponse("验证码不对或已经过期"),
    401: errorResponse("没有登录"),
    409: errorResponse("新邮箱已经被别人注册了"),
  },
});

const ExportView = z.object({
  id: z.string(),
  status: z.enum(["pending", "building", "ready", "failed", "expired"]),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  sizeBytes: z.number().nullable(),
});

const ExportOverview = z.object({
  latest: ExportView.nullable().openapi({ description: "最近一次导出；没导出过为 null" }),
  nextAvailableAt: z
    .string()
    .nullable()
    .openapi({ description: "什么时候可以再导出；null 表示现在就可以" }),
});

const exportStatusRoute = createRoute({
  method: "get",
  path: "/export",
  summary: "导出数据的状态",
  responses: {
    200: { description: "状态", ...json(ExportOverview) },
    401: errorResponse("没有登录"),
  },
});

const exportRequestRoute = createRoute({
  method: "post",
  path: "/export",
  summary: "申请导出数据",
  description: "后台打包，好了发邮件；24 小时内可以下载。每 24 小时只能申请一次，没打成的不算。",
  responses: {
    202: { description: "已申请", ...json(ExportOverview) },
    401: errorResponse("没有登录"),
    429: errorResponse("24 小时内已经导出过"),
  },
});

const exportDownloadRoute = createRoute({
  method: "get",
  path: "/export/{id}/download",
  summary: "下载导出的压缩包",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "压缩包", content: { "application/zip": { schema: z.any() } } },
    401: errorResponse("没有登录"),
    404: errorResponse("没有这个导出，或者已经过期"),
  },
});

const deleteSendCodeRoute = createRoute({
  method: "post",
  path: "/delete/send-code",
  summary: "删除账户：给账户邮箱发验证码",
  responses: {
    204: { description: "已发送" },
    401: errorResponse("没有登录"),
    429: errorResponse("操作太频繁"),
  },
});

const deleteRoute = createRoute({
  method: "post",
  path: "/delete",
  summary: "删除账户：填验证码确认",
  description:
    "立即停用：退出所有设备，解绑第三方账号，停下所有会话；数据 15 天内彻底删除。GitHub 上的分支和 PR 不动。",
  request: { body: json(z.object({ code: Code })) },
  responses: {
    204: { description: "已删除" },
    400: errorResponse("验证码不对或已经过期"),
    401: errorResponse("没有登录"),
  },
});

const exportView = (row: ExportRow) => ({
  id: row.id,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
  sizeBytes: row.sizeBytes,
});

/** 账户设置：登录方式、邮箱、导出数据、删除账户。 */
export function accountRoutes(deps: AppDeps, limiter: RateLimiter, sessions: Sessions) {
  const overview = async (userId: string) => {
    const { latest, nextAvailableAt } = await exportOverview(deps, userId);
    return {
      latest: latest && exportView(latest),
      nextAvailableAt: nextAvailableAt?.toISOString() ?? null,
    };
  };
  return newRouter()
    .openapi(identitiesRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const rows = await deps.db
        .select({ provider: identities.provider, login: identities.login })
        .from(identities)
        .where(eq(identities.userId, me.id))
        .orderBy(asc(identities.provider));
      return c.json({ email: me.email, identities: rows }, 200);
    })
    .openapi(unlinkRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const { provider } = c.req.valid("json");
      const removed = await deps.db.transaction(async (tx) => {
        const rows = await tx
          .delete(identities)
          .where(and(eq(identities.userId, me.id), eq(identities.provider, provider)))
          .returning({ id: identities.id });
        if (provider === "github") {
          await tx.delete(githubTokens).where(eq(githubTokens.userId, me.id));
        }
        return rows.length > 0;
      });
      if (!removed) return c.json(apiError("not_linked", "未绑定该类账号"), 404);
      return c.body(null, 204);
    })
    .openapi(sendCodeRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const { email } = c.req.valid("json");
      // 查邮箱有没有被占用单独限次数（防止拿它试探谁注册过）；真正发信再按发信的次数限。
      const checkWait = limiter.take([
        { key: `change-email-check:${me.id}`, limit: 30, windowMs: HOUR },
      ]);
      if (checkWait > 0) return tooFrequent(c, checkWait);
      const error = await checkNewEmail(deps, me, email);
      if (error) {
        const { status, message } = emailChangeErrors[error];
        return c.json(apiError(error, message), status);
      }
      const wait = limiter.take([
        { key: `change-email:${me.id}`, limit: 1, windowMs: MINUTE },
        { key: `change-email:${me.id}`, limit: 5, windowMs: HOUR },
      ]);
      if (wait > 0) return tooFrequent(c, wait);
      await sendEmailChangeCode(deps, me, email);
      return c.body(null, 204);
    })
    .openapi(confirmRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const result = await confirmEmailChange(deps, me, c.req.valid("json").code);
      if (!result.ok) {
        const { status, message } = emailChangeErrors[result.error];
        return c.json(apiError(result.error, message), status);
      }
      return c.json({ email: result.email }, 200);
    })
    .openapi(exportStatusRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      return c.json(await overview(me.id), 200);
    })
    .openapi(exportRequestRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const result = await requestExport(deps, me.id);
      if (!result.ok) {
        const wait = result.nextAvailableAt.getTime() - deps.clock.now().getTime();
        c.header("Retry-After", String(Math.ceil(Math.max(wait, 0) / 1000)));
        return c.json(
          apiError(
            "export_too_soon",
            `每 ${EXPORT_INTERVAL_MS / 3_600_000} 小时仅可导出一次，请稍后重试`,
          ),
          429,
        );
      }
      return c.json(await overview(me.id), 202);
    })
    .openapi(exportDownloadRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const file = await downloadableExport(deps, me.id, c.req.valid("param").id);
      if (!file) return c.json(apiError("export_not_found", "导出不存在或已过期"), 404);
      const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream;
      return c.body(body, 200, {
        "content-type": "application/zip",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
      }) as never;
    })
    .openapi(deleteSendCodeRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const wait = limiter.take([
        { key: `delete-account:${me.id}`, limit: 1, windowMs: MINUTE },
        { key: `delete-account:${me.id}`, limit: 5, windowMs: HOUR },
      ]);
      if (wait > 0) return tooFrequent(c, wait);
      await sendDeletionCode(deps, me);
      return c.body(null, 204);
    })
    .openapi(deleteRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const result = await confirmDeletion(deps, sessions, me, c.req.valid("json").code);
      if (!result.ok) {
        return c.json(apiError("invalid_code", "验证码错误或已过期，请重新获取"), 400);
      }
      // 登录状态在数据库里已经删了，浏览器里的 Cookie 也清掉。
      forgetLoginCookie(c);
      return c.body(null, 204);
    });
}
