import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app";
import { upstreamErrors } from "../db/schema";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { deleteProviderKey, providerStatus, setProviderKey } from "../gateway/trunk";
import { jsonBody as json, newRouter } from "./router";

const ProviderStatus = z
  .object({
    name: z.string(),
    keySet: z.boolean(),
    keySetAt: z.string().nullable().openapi({ description: "保存 key 的时间；没填时为 null" }),
    keyRejectedAt: z
      .string()
      .nullable()
      .openapi({ description: "上游最近一次说 key 不对的时间；换了 key 以后清掉" }),
  })
  .openapi("ModelProviderStatus", { description: "模型服务提供方的 key 的状态，不含原文" });

const getProviderRoute = createRoute({
  method: "get",
  path: "/settings/model-provider",
  summary: "模型服务提供方（DeepSeek）的 key 的状态",
  responses: {
    200: { description: "状态，不含 key 的原文", ...json(ProviderStatus) },
    401: errorResponse("没有登录"),
  },
});

const putKeyRoute = createRoute({
  method: "put",
  path: "/settings/model-provider/key",
  summary: "填写或替换 DeepSeek API key",
  description: "加密存放（SEEKCLOUD_SECRET_KEY），之后不再显示原文。",
  request: {
    body: {
      ...json(
        z.object({
          apiKey: z
            .string()
            .trim()
            .min(1, { error: "请填写 API key" })
            .max(200, { error: "API key 过长" })
            .regex(/^\S+$/, { error: "API key 不能包含空格或换行" }),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: { description: "保存以后的状态", ...json(ProviderStatus) },
    400: errorResponse("key 为空、过长或带空白"),
    401: errorResponse("没有登录"),
  },
});

const deleteKeyRoute = createRoute({
  method: "delete",
  path: "/settings/model-provider/key",
  summary: "删除 DeepSeek API key",
  description: "删除以后发起会话会提示先填 key；运行中的会话的模型调用会失败。",
  responses: {
    200: { description: "删除以后的状态", ...json(ProviderStatus) },
    401: errorResponse("没有登录"),
  },
});

const errorRoute = createRoute({
  method: "get",
  path: "/model-errors/{ref}",
  summary: "按参考号查一次模型服务出错",
  description:
    "开源版对管理员透明：带着上游的原始报错（ADR 0007 的 2026-11-14 修订）。只给浏览器，不进沙箱。",
  request: { params: z.object({ ref: z.string().max(40) }) },
  responses: {
    200: { description: "出错的内容", ...json(z.record(z.string(), z.unknown())) },
    401: errorResponse("没有登录"),
    404: errorResponse("没有这个参考号，或者已经超过保存期限"),
  },
});

/** 设置的"模型"一类，以及按参考号查模型服务出错。 */
export function modelRoutes(deps: AppDeps) {
  return newRouter()
    .openapi(getProviderRoute, async (c) => {
      if (!(await deps.identity.currentUser(c))) return c.json(notLoggedIn, 401);
      return c.json(await providerStatus(deps), 200);
    })
    .openapi(putKeyRoute, async (c) => {
      if (!(await deps.identity.currentUser(c))) return c.json(notLoggedIn, 401);
      await setProviderKey(deps, c.req.valid("json").apiKey);
      return c.json(await providerStatus(deps), 200);
    })
    .openapi(deleteKeyRoute, async (c) => {
      if (!(await deps.identity.currentUser(c))) return c.json(notLoggedIn, 401);
      await deleteProviderKey(deps);
      return c.json(await providerStatus(deps), 200);
    })
    .openapi(errorRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      const [row] = await deps.db
        .select()
        .from(upstreamErrors)
        .where(
          and(eq(upstreamErrors.ref, c.req.valid("param").ref), eq(upstreamErrors.userId, me.id)),
        );
      if (!row)
        return c.json(apiError("model_error_not_found", "没有这个参考号，或已超过保存期限"), 404);
      const status =
        row.status !== null && row.status >= 400 && row.status <= 599 ? row.status : undefined;
      return c.json(
        deps.errorPresentation.present(
          {
            ref: row.ref,
            code: row.code,
            status,
            provider: row.provider,
            upstream: { status: row.status, body: row.body },
            createdAt: row.createdAt.toISOString(),
          },
          me,
        ),
        200,
      );
    });
}
