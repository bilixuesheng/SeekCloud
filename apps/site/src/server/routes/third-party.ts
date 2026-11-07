import { createRoute, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app";
import { accountErrors } from "../auth/accounts";
import { currentUser } from "../auth/login-sessions";
import {
  cancelPending,
  describePending,
  linkPending,
  registerFromPending,
} from "../auth/third-party";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { clientIp, HOUR, type RateLimiter, tooFrequent } from "../rate-limit";
import { AcceptTerms } from "./auth";
import { jsonBody as json, newRouter } from "./router";

const Provider = z.enum(["github"]);

const pendingRoute = createRoute({
  method: "get",
  path: "/",
  summary: "这个浏览器里待处理的第三方身份",
  responses: {
    200: {
      description: "待处理的身份",
      ...json(
        z.object({
          provider: Provider,
          login: z.string(),
          email: z.string().nullable(),
          emailTaken: z.boolean().openapi({ description: "第三方的邮箱已经是别的账户的" }),
          canRegister: z.boolean().openapi({ description: "能不能用它创建新账户" }),
        }),
      ),
    },
    404: errorResponse("没有待处理的身份，或者已经过期"),
  },
});

const registerRoute = createRoute({
  method: "post",
  path: "/register",
  summary: "用待处理的第三方身份创建新账户：填邀请码，注册并登录",
  request: {
    body: json(z.object({ inviteCode: z.string(), acceptTerms: AcceptTerms })),
  },
  responses: {
    201: {
      description: "已注册并登录",
      ...json(z.object({ user: z.object({ id: z.string(), email: z.string() }) })),
    },
    400: errorResponse("邀请码有问题、没有同意协议或授权已过期"),
    403: errorResponse("内测名额已满"),
    409: errorResponse("邮箱或第三方账号已被占用"),
    429: errorResponse("填错邀请码太多次"),
  },
});

const linkRoute = createRoute({
  method: "post",
  path: "/link",
  summary: "登录已有账户以后，确认把待处理的第三方身份绑定到当前账户",
  responses: {
    200: { description: "已绑定", ...json(z.object({ provider: Provider, login: z.string() })) },
    400: errorResponse("授权已过期"),
    401: errorResponse("没有登录"),
    409: errorResponse("这个第三方账号已经绑定了别的账户，或者当前账户已经有同类账号"),
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/cancel",
  summary: "不用这个第三方账号了",
  responses: { 204: { description: "已放弃" } },
});

/** 陌生的第三方账号：创建新账户，或者登录已有账户后确认绑定。 */
export function pendingIdentityRoutes(deps: AppDeps, limiter: RateLimiter) {
  return newRouter()
    .openapi(pendingRoute, async (c) => {
      const pending = await describePending(deps, c);
      if (!pending) return c.json(apiError("no_pending", "不存在待处理的第三方账号"), 404);
      return c.json(pending, 200);
    })
    .openapi(registerRoute, async (c) => {
      const wait = limiter.take([{ key: `invite-ip:${clientIp(c)}`, limit: 10, windowMs: HOUR }]);
      if (wait > 0) return tooFrequent(c, wait);
      const result = await registerFromPending(deps, c, c.req.valid("json"));
      if (!result.ok) {
        const { status, message } = accountErrors[result.error];
        return c.json(apiError(result.error, message), status as 400 | 403 | 409);
      }
      return c.json({ user: { id: result.value.userId, email: result.value.email } }, 201);
    })
    .openapi(linkRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const result = await linkPending(deps, c, me.id);
      if (!result.ok) {
        const { status, message } = accountErrors[result.error];
        return c.json(apiError(result.error, message), status as 400 | 409);
      }
      return c.json(result.value, 200);
    })
    .openapi(cancelRoute, async (c) => {
      await cancelPending(deps, c);
      return c.body(null, 204);
    });
}
