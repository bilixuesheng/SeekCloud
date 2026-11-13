import { createRoute, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app";
import { currentUser } from "../auth/login-sessions";
import { errorResponse, notLoggedIn } from "../errors";
import type { Sessions } from "../sessions/sessions";
import {
  AiLabelsValue,
  EffortValue,
  getAiLabels,
  getDefaultEffort,
  setAiLabels,
  setDefaultEffort,
} from "../settings";
import { jsonBody as json, newRouter } from "./router";

const AiLabels = AiLabelsValue.openapi("AiLabels", {
  description:
    "AI 标识的两个开关。signature：issue、PR、评论末尾的署名；commitTrailer：提交说明末尾的尾注。",
});

const getAiLabelsRoute = createRoute({
  method: "get",
  path: "/ai-labels",
  summary: "AI 标识的开关",
  responses: {
    200: { description: "两个开关，默认都开", ...json(AiLabels) },
    401: errorResponse("没有登录"),
  },
});

const putAiLabelsRoute = createRoute({
  method: "put",
  path: "/ai-labels",
  summary: "修改 AI 标识的开关",
  description: "改了以后，运行中的会话跟着变，不用重开。",
  request: { body: { ...json(AiLabels), required: true } },
  responses: {
    200: { description: "改好以后的值", ...json(AiLabels) },
    400: errorResponse("请求格式不对"),
    401: errorResponse("没有登录"),
  },
});

const DefaultEffort = z
  .object({ effort: EffortValue })
  .openapi("DefaultEffort", { description: "新会话默认的思考强度" });

const getDefaultEffortRoute = createRoute({
  method: "get",
  path: "/default-effort",
  summary: "新会话默认的思考强度",
  responses: {
    200: { description: "没改过时是 high", ...json(DefaultEffort) },
    401: errorResponse("没有登录"),
  },
});

const putDefaultEffortRoute = createRoute({
  method: "put",
  path: "/default-effort",
  summary: "修改新会话默认的思考强度",
  description: "只影响之后发起的会话，已有的会话不变。",
  request: { body: { ...json(DefaultEffort), required: true } },
  responses: {
    200: { description: "改好以后的值", ...json(DefaultEffort) },
    400: errorResponse("请求格式不对"),
    401: errorResponse("没有登录"),
  },
});

/** 设置窗口里的全站设置。 */
export function settingsRoutes(deps: AppDeps, sessions: Sessions) {
  return newRouter()
    .openapi(getAiLabelsRoute, async (c) => {
      if (!(await currentUser(deps, c))) return c.json(notLoggedIn, 401);
      return c.json(await getAiLabels(deps), 200);
    })
    .openapi(putAiLabelsRoute, async (c) => {
      if (!(await currentUser(deps, c))) return c.json(notLoggedIn, 401);
      const value = c.req.valid("json");
      await setAiLabels(deps, value);
      await sessions.aiLabelsChanged(value);
      return c.json(value, 200);
    })
    .openapi(getDefaultEffortRoute, async (c) => {
      if (!(await currentUser(deps, c))) return c.json(notLoggedIn, 401);
      return c.json({ effort: await getDefaultEffort(deps) }, 200);
    })
    .openapi(putDefaultEffortRoute, async (c) => {
      if (!(await currentUser(deps, c))) return c.json(notLoggedIn, 401);
      const { effort } = c.req.valid("json");
      await setDefaultEffort(deps, effort);
      return c.json({ effort }, 200);
    });
}
