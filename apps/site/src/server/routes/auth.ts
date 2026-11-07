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
import { humanCheckErrors } from "../human-check";
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

/** 浏览器从 Turnstile 拿到的令牌。 */
export const HumanCheckToken = z
  .string()
  .max(4096)
  .optional()
  .openapi({ description: "Cloudflare Turnstile 给的令牌" });

const sendCodeRoute = createRoute({
  method: "post",
  path: "/email/send-code",
  summary: "发邮箱验证码",
  request: {
    body: json(z.object({ email: Email, humanCheckToken: HumanCheckToken })),
  },
  responses: {
    204: { description: "已发送" },
    400: errorResponse("人机验证没通过"),
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
        /** 带邀请码（注册）时必须有。 */
        humanCheckToken: HumanCheckToken,
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
    503: errorResponse("人机验证服务暂时连不上"),
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
      const { email, humanCheckToken } = c.req.valid("json");
      const ip = clientIp(c);
      const rules: Rule[] = [
        { key: `send:${email}`, limit: 1, windowMs: MINUTE },
        { key: `send:${email}`, limit: 5, windowMs: HOUR },
        { key: `send-ip:${ip}`, limit: 20, windowMs: HOUR },
      ];
      // 浏览器连不上 Cloudflare、拿不到令牌时也让老用户能登录，只是同一个 IP 限得更紧。
      const unverified = deps.humanCheck.siteKey !== null && !humanCheckToken;
      if (unverified) {
        console.warn(`发验证码没带人机验证令牌（IP ${ip}）`);
        rules.push({ key: `send-unverified-ip:${ip}`, limit: 3, windowMs: HOUR });
      }
      const wait = limiter.take(rules);
      if (wait > 0) return tooFrequent(c, wait);
      if (!unverified) {
        const check = await deps.humanCheck.verify(humanCheckToken, { action: "send_code", ip });
        // 主站连不上 Cloudflare 时照常发：老用户不能因为第三方出问题登不进来，有频率限制兜底。
        if (check === "failed") {
          // 只退回按邮箱的次数（真用户重试不受影响）；按 IP 的照扣，
          // 免得有人拿伪造的令牌无限次打这个接口，每次都让主站去问 Cloudflare。
          limiter.release(rules.filter((rule) => rule.key.startsWith("send:")));
          return c.json(humanCheckErrors.failed, 400);
        }
      }
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
      // 注册要过人机验证；老用户登录不用。没通过就不往下走，验证码和邀请码都不算用掉。
      if (input.inviteCode) {
        const check = await deps.humanCheck.verify(input.humanCheckToken, {
          action: "signup",
          ip: clientIp(c),
        });
        if (check === "failed") return c.json(humanCheckErrors.failed, 400);
        if (check === "unavailable") return c.json(humanCheckErrors.unavailable, 503);
      }
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
