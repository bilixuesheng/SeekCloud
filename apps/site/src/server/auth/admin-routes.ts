import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { networkOf } from "../access-log";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { clientIp, HOUR, type RateLimiter, tooFrequent } from "../rate-limit";
import { Nickname } from "../routes/me";
import { jsonBody as json, newRouter } from "../routes/router";
import { checkPassword, setPassword, setUpAdmin } from "./admin";
import {
  currentUser,
  endAllLoginSessions,
  endLoginSession,
  endLoginSessionById,
  type LoginDeps,
  listLoginSessions,
  loginTokenHash,
  MAX_DEVICE_NAME,
  startLoginSession,
} from "./login-sessions";
import { MAX_PASSWORD_LENGTH } from "./password";

const NewPassword = z
  .string()
  .min(8, { error: "密码至少 8 位" })
  .max(MAX_PASSWORD_LENGTH, { error: `密码最长 ${MAX_PASSWORD_LENGTH} 位` });

const setupRoute = createRoute({
  method: "post",
  path: "/setup",
  summary: "首次设置管理员的昵称和密码，设置后直接登录",
  request: { body: json(z.object({ nickname: Nickname, password: NewPassword })) },
  responses: {
    204: { description: "已设置并登录" },
    400: errorResponse("昵称为空或过长，密码不足 8 位或超过 256 位"),
    409: errorResponse("已经设置过管理员密码"),
  },
});

const loginRoute = createRoute({
  method: "post",
  path: "/login",
  summary: "用管理员密码登录",
  description:
    "浏览器登录时设 Cookie，回 204。安卓 App 登录时带 client: app 和设备名，不设 Cookie，回 200 和设备令牌：" +
    "之后的请求带 Authorization: Bearer <令牌>（带了它就只按令牌认，不看 Cookie）。令牌只在这里出现一次。",
  request: {
    body: json(
      z.object({
        password: z.string(),
        client: z.literal("app").optional(),
        deviceName: z.string().trim().min(1).max(MAX_DEVICE_NAME).optional(),
      }),
    ),
  },
  responses: {
    200: {
      description: "App 已登录",
      ...json(z.object({ token: z.string() }).openapi("DeviceToken")),
    },
    204: { description: "浏览器已登录" },
    400: errorResponse("密码错误"),
    429: errorResponse("输错密码太多次"),
  },
});

const LoginDevice = z
  .object({
    id: z.string(),
    client: z.enum(["browser", "app"]),
    deviceName: z.string().nullable(),
    current: z.boolean().openapi({ description: "是不是发这个请求的设备" }),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi("LoginDevice");

const devicesRoute = createRoute({
  method: "get",
  path: "/devices",
  summary: "登录着的设备",
  description: "浏览器和安卓 App 都算，最近用过的在前。",
  responses: {
    200: { description: "设备列表", ...json(z.object({ devices: z.array(LoginDevice) })) },
    401: errorResponse("没有登录"),
  },
});

const deviceLogoutRoute = createRoute({
  method: "delete",
  path: "/devices/{id}",
  summary: "退出某一台设备",
  description: "马上生效：那台设备的下一个请求就是没登录，连着的事件流在下一次保活时断开。",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "已退出" },
    401: errorResponse("没有登录"),
    404: errorResponse("没有这台设备"),
  },
});

const passwordRoute = createRoute({
  method: "post",
  path: "/password",
  summary: "修改管理员密码",
  description: "要先输入当前密码。改完后当前设备保持登录，其他设备全部退出。",
  request: {
    body: json(z.object({ currentPassword: z.string(), newPassword: NewPassword })),
  },
  responses: {
    204: { description: "已修改" },
    400: errorResponse("当前密码错误，或新密码不足 8 位、超过 256 位"),
    401: errorResponse("没有登录"),
    429: errorResponse("输错密码太多次"),
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

/**
 * 比对管理员密码，登录和改密码共用。同一个 IP 一小时最多输错 10 次，之后正确的密码也要等；输对的不算。
 * 先占一次再比对：同时到达的请求加起来也只能试 10 次。wait 是被限制时还要等的秒数。
 */
async function checkLimited(
  deps: LoginDeps,
  limiter: RateLimiter,
  c: Context,
  password: string,
): Promise<{ wait: number; userId?: string }> {
  // IPv6 按 /64 算一个来源：一个用户手里通常有一整个 /64，按单个地址限等于没限。
  const rules = [{ key: `password-ip:${networkOf(clientIp(c))}`, limit: 10, windowMs: HOUR }];
  const wait = limiter.take(rules);
  if (wait > 0) return { wait };
  const userId = await checkPassword(deps.db, password);
  if (userId) limiter.release(rules);
  return { wait: 0, userId };
}

export function authRoutes(deps: LoginDeps, limiter: RateLimiter) {
  return newRouter()
    .openapi(setupRoute, async (c) => {
      const { nickname, password } = c.req.valid("json");
      const userId = await setUpAdmin(deps, password, nickname);
      if (!userId) {
        return c.json(apiError("already_set_up", "已设置管理员密码，请直接登录"), 409);
      }
      await startLoginSession(deps, c, userId);
      return c.body(null, 204);
    })
    .openapi(loginRoute, async (c) => {
      const { wait, userId } = await checkLimited(deps, limiter, c, c.req.valid("json").password);
      if (wait > 0) return tooFrequent(c, wait);
      if (!userId) return c.json(apiError("wrong_password", "密码错误"), 400);
      const { client, deviceName } = c.req.valid("json");
      if (client === "app") {
        const token = await startLoginSession(deps, c, userId, {
          kind: "app",
          deviceName: deviceName ?? "安卓设备",
        });
        return c.json({ token }, 200);
      }
      await startLoginSession(deps, c, userId);
      return c.body(null, 204);
    })
    .openapi(passwordRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const { currentPassword, newPassword } = c.req.valid("json");
      const { wait, userId } = await checkLimited(deps, limiter, c, currentPassword);
      if (wait > 0) return tooFrequent(c, wait);
      if (userId !== me.id) return c.json(apiError("wrong_password", "当前密码错误"), 400);
      await setPassword(deps.db, me.id, newPassword, loginTokenHash(c));
      return c.body(null, 204);
    })
    .openapi(logoutRoute, async (c) => {
      await endLoginSession(deps, c);
      return c.body(null, 204);
    })
    .openapi(devicesRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      return c.json({ devices: await listLoginSessions(deps, c, me.id) }, 200);
    })
    .openapi(deviceLogoutRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!(await endLoginSessionById(deps, c, me.id, c.req.valid("param").id))) {
        return c.json(apiError("device_not_found", "没有这台设备"), 404);
      }
      return c.body(null, 204);
    })
    .openapi(logoutAllRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      await endAllLoginSessions(deps, c, me.id);
      return c.body(null, 204);
    });
}
