import { createRoute, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app";
import { getNickname, hasAdmin, setNickname } from "../auth/admin";
import { currentUser } from "../auth/login-sessions";
import { networkAccess } from "../db/schema";
import { listEnvironments } from "../environments";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { githubConnection } from "../github/tokens";
import { jsonBody as json, newRouter } from "./router";

const unauthorized = errorResponse("没有登录");

/** 昵称：首页的问候语里用。去掉首尾空格，1–20 个字。 */
export const Nickname = z
  .string()
  .trim()
  .min(1, { error: "昵称不能为空" })
  .max(20, { error: "昵称最长 20 个字" })
  .regex(/^[^\r\n\t]*$/, { error: "昵称不能换行" });

const meRoute = createRoute({
  method: "get",
  path: "/me",
  summary: "当前登录的管理员",
  responses: {
    200: {
      description: "管理员",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            githubLogin: z
              .string()
              .nullable()
              .openapi({ description: "关联的 GitHub 用户名；没关联时为 null" }),
            nickname: z
              .string()
              .nullable()
              .openapi({ description: "昵称；加上这个设置之前就部署好的，没填过时为 null" }),
          }),
        },
      },
    },
    401: errorResponse("没有登录；还没设置管理员密码时错误码是 setup_required"),
  },
});

const nicknameRoute = createRoute({
  method: "put",
  path: "/me/nickname",
  summary: "修改昵称",
  request: { body: { ...json(z.object({ nickname: Nickname })), required: true } },
  responses: {
    200: { description: "改好以后的昵称", ...json(z.object({ nickname: z.string() })) },
    400: errorResponse("昵称为空、过长或带换行"),
    401: unauthorized,
  },
});

const environmentsRoute = createRoute({
  method: "get",
  path: "/environments",
  summary: "我的环境",
  responses: {
    200: {
      description: "环境列表",
      content: {
        "application/json": {
          schema: z.object({
            environments: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                networkAccess: z.enum(networkAccess.enumValues),
                isDefault: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    401: unauthorized,
  },
});

export function meRoutes(deps: AppDeps) {
  return newRouter()
    .openapi(meRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) {
        if (await hasAdmin(deps.db)) return c.json(notLoggedIn, 401);
        return c.json(apiError("setup_required", "请先设置管理员密码"), 401);
      }
      const github = await githubConnection(deps, user.id);
      const nickname = await getNickname(deps.db, user.id);
      return c.json({ id: user.id, githubLogin: github?.login ?? null, nickname }, 200);
    })
    .openapi(nicknameRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const { nickname } = c.req.valid("json");
      await setNickname(deps.db, user.id, nickname);
      return c.json({ nickname }, 200);
    })
    .openapi(environmentsRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      return c.json({ environments: await listEnvironments(deps.db, user.id) }, 200);
    });
}
