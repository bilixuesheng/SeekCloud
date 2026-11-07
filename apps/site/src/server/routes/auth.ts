import { createRoute, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app";
import { accountErrors, verifyEmailLogin } from "../auth/accounts";
import { sendLoginCode } from "../auth/login-codes";
import {
  currentUser,
  endAllLoginSessions,
  endLoginSession,
  startLoginSession,
} from "../auth/login-sessions";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { clientIp, HOUR, MINUTE, type RateLimiter, type Rule, tooFrequent } from "../rate-limit";
import { jsonBody as json, newRouter } from "./router";

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "邮箱格式错误" }))
  .openapi({ example: "alice@example.com" });

const User = z.object({ id: z.string(), email: z.string() });

/** 注册时勾的"同意用户协议和隐私政策"。 */
export const AcceptTerms = z
  .boolean()
  .optional()
  .openapi({ description: "注册时必须为 true：同意用户协议和隐私政策" });

const sendCodeRoute = createRoute({
  method: "post",
  path: "/email/send-code",
  summary: "发邮箱验证码",
  request: {
    body: json(z.object({ email: Email })),
  },
  responses: {
    204: { description: "已发送" },
    429: errorResponse("操作太频繁"),
    502: errorResponse("邮件没发出去"),
  },
});

const verifyRoute = createRoute({
  method: "post",
  path: "/email/verify",
  summary: "用邮箱验证码登录；新邮箱要带邀请码，注册后直接登录",
  request: {
    body: json(
      z.object({
        email: Email,
        code: z.string().regex(/^\d{6}$/, { error: "验证码为 6 位数字" }),
        inviteCode: z.string().optional(),
        /** 注册时必须为 true。 */
        acceptTerms: AcceptTerms,
      }),
    ),
  },
  responses: {
    200: { description: "已登录", ...json(z.object({ user: User })) },
    201: { description: "已注册并登录", ...json(z.object({ user: User })) },
    400: errorResponse("验证码或邀请码有问题"),
    403: errorResponse("内测名额已满"),
    409: errorResponse("账户冲突"),
    429: errorResponse("填错邀请码太多次"),
  },
});

const logoutAllRoute = createRoute({
  method: "post",
  path: "/logout-all",
  summary: "在所有设备上退出登录",
  responses: { 204: { description: "已退出" }, 401: errorResponse("没有登录") },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  summary: "退出登录",
  responses: { 204: { description: "已退出" } },
});

export function authRoutes(deps: AppDeps, limiter: RateLimiter) {
  return newRouter()
    .openapi(sendCodeRoute, async (c) => {
      const { email } = c.req.valid("json");
      const rules: Rule[] = [
        { key: `send:${email}`, limit: 1, windowMs: MINUTE },
        { key: `send:${email}`, limit: 5, windowMs: HOUR },
        { key: `send-ip:${clientIp(c)}`, limit: 20, windowMs: HOUR },
      ];
      const wait = limiter.take(rules);
      if (wait > 0) return tooFrequent(c, wait);
      try {
        await sendLoginCode(deps, email);
      } catch (error) {
        console.error("验证码邮件发送失败", error);
        limiter.release(rules);
        return c.json(apiError("mail_failed", "验证码邮件发送失败，请稍后重试"), 502);
      }
      return c.body(null, 204);
    })
    .openapi(verifyRoute, async (c) => {
      const input = c.req.valid("json");
      const rules: Rule[] = [{ key: `verify-ip:${clientIp(c)}`, limit: 100, windowMs: HOUR }];
      // 带邀请码的请求另外计数，防止有人一个个试邀请码。不带邀请码的登录不受影响。
      if (input.inviteCode) {
        rules.push(
          { key: `invite-ip:${clientIp(c)}`, limit: 10, windowMs: HOUR },
          { key: `invite:${input.email}`, limit: 10, windowMs: HOUR },
        );
      }
      const wait = limiter.take(rules);
      if (wait > 0) return tooFrequent(c, wait);
      const result = await verifyEmailLogin(deps, input);
      if (!result.ok) {
        const { status, message } = accountErrors[result.error];
        return c.json(apiError(result.error, message), status);
      }
      await startLoginSession(deps, c, result.userId, result.registered ? "register" : "login");
      const user = { id: result.userId, email: input.email };
      return result.registered ? c.json({ user }, 201) : c.json({ user }, 200);
    })
    .openapi(logoutRoute, async (c) => {
      await endLoginSession(deps, c);
      return c.body(null, 204);
    })
    .openapi(logoutAllRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      await endAllLoginSessions(deps, c, me.id);
      return c.body(null, 204);
    });
}
