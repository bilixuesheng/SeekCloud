import { createRoute, z } from "@hono/zod-openapi";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { recordAccess } from "../access-log";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { type RateLimiter, tooFrequent } from "../rate-limit";
import { jsonBody as json, newRouter } from "../routes/router";
import { limited } from "./limits";
import { currentUser, type LoginDeps, MAX_DEVICE_NAME, startLoginSession } from "./login-sessions";
import {
  authenticationOptions,
  Challenges,
  deletePasskey,
  finishAuthentication,
  finishRegistration,
  listPasskeys,
  registrationOptions,
  relyingParty,
} from "./passkeys";
import { reauthenticate } from "./two-factor-routes";

/** 通行密钥的接口（#100）：设置里列出、添加、删除；登录页用它登录。 */

/** 浏览器交回来的结果（navigator.credentials 的 JSON 形式），细节由 SimpleWebAuthn 核对。 */
const CredentialJson = z.looseObject({
  id: z.string().max(1024),
  rawId: z.string().max(1024),
  type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: z.string().max(8192) }),
});

const PasskeyItem = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string().openapi({ format: "date-time" }),
    lastUsedAt: z.string().nullable(),
    usable: z.boolean().openapi({ description: "主站换了地址以后，旧地址上添加的用不了" }),
  })
  .openapi("Passkey");

const Reauth = z.object({
  password: z.string(),
  code: z.string().max(64).optional().openapi({ description: "开了两步验证时要带" }),
});

const unavailable = () =>
  apiError(
    "passkeys_unavailable",
    "通行密钥需要通过 HTTPS 访问主站，并设置环境变量 PUBLIC_URL 为主站对外的地址",
  );

const listRoute = createRoute({
  method: "get",
  path: "/passkeys",
  summary: "通行密钥",
  responses: {
    200: {
      description: "列表，最早添加的在前",
      ...json(
        z.object({
          available: z
            .boolean()
            .openapi({ description: "配了 PUBLIC_URL 且是 HTTPS（或本机 localhost）" }),
          rpId: z.string().nullable(),
          passkeys: z.array(PasskeyItem),
        }),
      ),
    },
    401: errorResponse("没有登录"),
  },
});

const registerOptionsRoute = createRoute({
  method: "post",
  path: "/passkeys/register/options",
  summary: "添加通行密钥的第一步：再验证一次，拿到给浏览器的参数",
  request: { body: json(Reauth) },
  responses: {
    200: {
      description: "navigator.credentials.create 的参数（JSON 形式）",
      ...json(z.looseObject({})),
    },
    400: errorResponse("密码或验证码错误"),
    401: errorResponse("没有登录"),
    409: errorResponse("这个部署用不了通行密钥"),
    429: errorResponse("输错太多次"),
  },
});

const registerRoute = createRoute({
  method: "post",
  path: "/passkeys/register",
  summary: "添加通行密钥的第二步：交回浏览器的结果",
  request: {
    body: json(
      z.object({
        name: z.string().trim().min(1, "请填写名称").max(50, "名称最长 50 个字"),
        credential: CredentialJson,
      }),
    ),
  },
  responses: {
    201: { description: "已添加", ...json(PasskeyItem) },
    400: errorResponse("核对不通过（超时、取消、不是这个网站的）"),
    401: errorResponse("没有登录"),
    409: errorResponse("这个部署用不了通行密钥"),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/passkeys/{id}",
  summary: "删除一个通行密钥",
  description: "要再输一次密码（开了两步验证的再加验证码）。",
  request: { params: z.object({ id: z.uuid() }), body: json(Reauth) },
  responses: {
    204: { description: "已删除" },
    400: errorResponse("密码或验证码错误"),
    401: errorResponse("没有登录"),
    404: errorResponse("没有这个通行密钥"),
    429: errorResponse("输错太多次"),
  },
});

const loginOptionsRoute = createRoute({
  method: "post",
  path: "/passkeys/login/options",
  summary: "用通行密钥登录的第一步：给浏览器的参数",
  responses: {
    200: {
      description: "navigator.credentials.get 的参数（JSON 形式）",
      ...json(z.looseObject({})),
    },
    409: errorResponse("这个部署用不了通行密钥"),
  },
});

const loginRoute = createRoute({
  method: "post",
  path: "/passkeys/login",
  summary: "用通行密钥登录的第二步：交回浏览器的结果",
  description:
    "通过后直接登录，不用再输密码和验证码：浏览器设 Cookie 回 204，App（client: app）回 200 和设备令牌。" +
    "失败计入登录的频率限制。",
  request: {
    body: json(
      z.object({
        credential: CredentialJson,
        client: z.literal("app").optional(),
        deviceName: z.string().trim().min(1).max(MAX_DEVICE_NAME).optional(),
      }),
    ),
  },
  responses: {
    200: { description: "App 已登录", ...json(z.object({ token: z.string() })) },
    204: { description: "浏览器已登录" },
    400: errorResponse("核对不通过"),
    409: errorResponse("这个部署用不了通行密钥"),
    429: errorResponse("失败太多次"),
  },
});

export function passkeyRoutes(deps: LoginDeps, limiter: RateLimiter) {
  const challenges = new Challenges(deps.clock);
  const rp = relyingParty(deps.publicUrl);
  return newRouter()
    .openapi(listRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const list = await listPasskeys(deps, me.id);
      return c.json(
        { available: Boolean(list.rp), rpId: list.rp?.rpId ?? null, passkeys: list.passkeys },
        200,
      );
    })
    .openapi(registerOptionsRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!rp) return c.json(unavailable(), 409);
      const { password, code } = c.req.valid("json");
      const denied = await reauthenticate(deps, limiter, c, me.id, password, code);
      if (denied) return denied;
      return c.json(await registrationOptions(deps, challenges, rp, me.id), 200);
    })
    .openapi(registerRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!rp) return c.json(unavailable(), 409);
      const { name, credential } = c.req.valid("json");
      const added = await finishRegistration(
        deps,
        challenges,
        rp,
        me.id,
        credential as unknown as RegistrationResponseJSON,
        name,
      );
      if (!added) {
        return c.json(apiError("passkey_invalid", "通行密钥验证失败，请重试"), 400);
      }
      await recordAccess(deps, c, me.id, "passkey_add");
      return c.json(added, 201);
    })
    .openapi(deleteRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const { password, code } = c.req.valid("json");
      const denied = await reauthenticate(deps, limiter, c, me.id, password, code);
      if (denied) return denied;
      if (!(await deletePasskey(deps, me.id, c.req.valid("param").id))) {
        return c.json(apiError("passkey_not_found", "没有这个通行密钥"), 404);
      }
      await recordAccess(deps, c, me.id, "passkey_remove");
      return c.body(null, 204);
    })
    .openapi(loginOptionsRoute, async (c) => {
      if (!rp) return c.json(unavailable(), 409);
      return c.json(await authenticationOptions(challenges, rp), 200);
    })
    .openapi(loginRoute, async (c) => {
      if (!rp) return c.json(unavailable(), 409);
      const { credential, client, deviceName } = c.req.valid("json");
      const { wait, value: userId } = await limited(deps, limiter, c, () =>
        finishAuthentication(
          deps,
          challenges,
          rp,
          credential as unknown as AuthenticationResponseJSON,
        ),
      );
      if (wait > 0) return tooFrequent(c, wait);
      if (!userId) return c.json(apiError("passkey_invalid", "通行密钥验证失败"), 400);
      if (client === "app") {
        const token = await startLoginSession(deps, c, userId, {
          kind: "app",
          deviceName: deviceName ?? "安卓设备",
        });
        return c.json({ token }, 200);
      }
      await startLoginSession(deps, c, userId);
      return c.body(null, 204);
    });
}
