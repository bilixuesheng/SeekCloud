import { createRoute, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app";
import { currentUser } from "../auth/login-sessions";
import { networkAccess } from "../db/schema";
import { listEnvironments } from "../environments";
import { errorResponse, notLoggedIn } from "../errors";
import { newRouter } from "./router";

const unauthorized = errorResponse("没有登录");

const meRoute = createRoute({
  method: "get",
  path: "/me",
  summary: "当前登录的用户",
  responses: {
    200: {
      description: "当前用户",
      content: {
        "application/json": { schema: z.object({ id: z.string(), email: z.string() }) },
      },
    },
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
      return user ? c.json(user, 200) : c.json(notLoggedIn, 401);
    })
    .openapi(environmentsRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      return c.json({ environments: await listEnvironments(deps.db, user.id) }, 200);
    });
}
