import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { recordAccess } from "../access-log";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { type RateLimiter, tooFrequent } from "../rate-limit";
import { jsonBody as json, newRouter } from "../routes/router";
import { checkPassword } from "./admin";
import { limited } from "./limits";
import { currentUser, type LoginDeps } from "./login-sessions";
import { otpauthUrl } from "./totp";
import {
  disableTotp,
  enableTotp,
  openPending,
  regenerateRecoveryCodes,
  startTotpSetup,
  twoFactorState,
  verifySecondFactor,
} from "./two-factor";

/** 设置的"账户"里的两步验证（#100）：开启、关闭、重新生成恢复码。 */

const Code = z.string().max(64);
const RecoveryCodes = z
  .object({ recoveryCodes: z.array(z.string()).openapi({ description: "只在这里出现一次" }) })
  .openapi("RecoveryCodes");

const stateRoute = createRoute({
  method: "get",
  path: "/two-factor",
  summary: "两步验证开了没有",
  responses: {
    200: {
      description: "状态",
      ...json(z.object({ enabled: z.boolean(), recoveryCodesLeft: z.number().int() })),
    },
    401: errorResponse("没有登录"),
  },
});

const setupRoute = createRoute({
  method: "post",
  path: "/two-factor/setup",
  summary: "开启两步验证的第一步：输密码，拿到密钥和二维码地址",
  description:
    "密钥这时还没存：带着 setupToken 和验证器 App 显示的验证码调 /two-factor/enable 才生效。",
  request: { body: json(z.object({ password: z.string() })) },
  responses: {
    200: {
      description: "新的密钥",
      ...json(
        z.object({
          secret: z.string().openapi({ description: "base32，手动输入验证器 App 时用" }),
          otpauthUrl: z.string().openapi({ description: "二维码里的地址" }),
          setupToken: z.string().openapi({ description: "5 分钟内有效" }),
        }),
      ),
    },
    400: errorResponse("密码错误"),
    401: errorResponse("没有登录"),
    409: errorResponse("已经开着"),
    429: errorResponse("输错太多次"),
  },
});

const enableRoute = createRoute({
  method: "post",
  path: "/two-factor/enable",
  summary: "开启两步验证的第二步：输一次验证码确认",
  description: "成功后回 10 个恢复码，只显示这一次。",
  request: { body: json(z.object({ setupToken: z.string().max(4000), code: Code })) },
  responses: {
    200: { description: "已开启", ...json(RecoveryCodes) },
    400: errorResponse("验证码错误，或者设置已超时"),
    401: errorResponse("没有登录"),
    409: errorResponse("已经开着"),
  },
});

const reauthBody = z.object({
  password: z.string(),
  code: Code.openapi({ description: "验证码或恢复码" }),
});

const disableRoute = createRoute({
  method: "post",
  path: "/two-factor/disable",
  summary: "关闭两步验证",
  description: "要输密码和验证码（或恢复码）。密钥和恢复码都删掉。",
  request: { body: json(reauthBody) },
  responses: {
    204: { description: "已关闭" },
    400: errorResponse("密码或验证码错误"),
    401: errorResponse("没有登录"),
    409: errorResponse("没有开"),
    429: errorResponse("输错太多次"),
  },
});

const regenerateRoute = createRoute({
  method: "post",
  path: "/two-factor/recovery-codes",
  summary: "重新生成恢复码",
  description: "要输密码和验证码（或恢复码）。旧的恢复码全部作废。",
  request: { body: json(reauthBody) },
  responses: {
    200: { description: "新的恢复码", ...json(RecoveryCodes) },
    400: errorResponse("密码或验证码错误"),
    401: errorResponse("没有登录"),
    409: errorResponse("没有开"),
    429: errorResponse("输错太多次"),
  },
});

/**
 * 敏感操作（改密码、关两步验证、重新生成恢复码、显示密钥）前再验证一次：密码；开了两步验证的再加验证码或恢复码。
 * 输错计入登录的频率限制。通过时返回 undefined，否则返回要回给浏览器的响应。
 */
export async function reauthenticate(
  deps: LoginDeps,
  limiter: RateLimiter,
  c: Context,
  userId: string,
  password: string,
  code: string | undefined,
) {
  const checked = await limited(limiter, c, async () =>
    (await checkPassword(deps.db, password)) === userId ? true : undefined,
  );
  if (checked.wait > 0) return tooFrequent(c, checked.wait);
  if (!checked.value) return c.json(apiError("wrong_password", "当前密码错误"), 400);
  if (!(await twoFactorState(deps, userId)).enabled) return undefined;
  if (!code?.trim()) {
    return c.json(apiError("code_required", "请输入两步验证的验证码"), 400);
  }
  const verified = await limited(limiter, c, async () =>
    (await verifySecondFactor(deps, userId, code)) ? true : undefined,
  );
  if (verified.wait > 0) return tooFrequent(c, verified.wait);
  if (!verified.value) return c.json(apiError("wrong_code", "验证码错误"), 400);
  return undefined;
}

/** 验证器 App 里怎么叫这个部署：主站的域名（几个部署能分开），取不到时写 admin。 */
function accountName(c: Context): string {
  const host = c.req.header("host") ?? "";
  return /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host) ? host.replace(/:\d+$/, "") : "admin";
}

export function twoFactorRoutes(deps: LoginDeps, limiter: RateLimiter) {
  return newRouter()
    .openapi(stateRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      return c.json(await twoFactorState(deps, me.id), 200);
    })
    .openapi(setupRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      if ((await twoFactorState(deps, me.id)).enabled) {
        return c.json(apiError("already_enabled", "两步验证已开启"), 409);
      }
      const denied = await reauthenticate(
        deps,
        limiter,
        c,
        me.id,
        c.req.valid("json").password,
        undefined,
      );
      if (denied) return denied;
      const { secret, setupToken } = startTotpSetup(deps, me.id);
      return c.json({ secret, otpauthUrl: otpauthUrl(secret, accountName(c)), setupToken }, 200);
    })
    .openapi(enableRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const { setupToken, code } = c.req.valid("json");
      const setup = openPending(deps, setupToken, "setup");
      if (!setup || setup.userId !== me.id) {
        return c.json(apiError("setup_expired", "设置已超时，请重新开始"), 400);
      }
      // 开启时输错不计入登录的频率限制：已经登录、输过密码了，服务器时钟不准时也不至于把自己锁在外面
      const result = await enableTotp(deps, me.id, setup.secret, code);
      if (result === "already_enabled") {
        return c.json(apiError("already_enabled", "两步验证已开启"), 409);
      }
      if (result === "wrong_code") return c.json(apiError("wrong_code", "验证码错误"), 400);
      await recordAccess(deps, c, me.id, "two_factor_on");
      return c.json({ recoveryCodes: result }, 200);
    })
    .openapi(disableRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!(await twoFactorState(deps, me.id)).enabled) {
        return c.json(apiError("not_enabled", "两步验证未开启"), 409);
      }
      const { password, code } = c.req.valid("json");
      const denied = await reauthenticate(deps, limiter, c, me.id, password, code);
      if (denied) return denied;
      await disableTotp(deps, me.id);
      await recordAccess(deps, c, me.id, "two_factor_off");
      return c.body(null, 204);
    })
    .openapi(regenerateRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!(await twoFactorState(deps, me.id)).enabled) {
        return c.json(apiError("not_enabled", "两步验证未开启"), 409);
      }
      const { password, code } = c.req.valid("json");
      const denied = await reauthenticate(deps, limiter, c, me.id, password, code);
      if (denied) return denied;
      return c.json({ recoveryCodes: await regenerateRecoveryCodes(deps, me.id) }, 200);
    });
}
