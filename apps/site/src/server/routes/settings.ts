import { createRoute, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import type { Sessions } from "../sessions/sessions";
import {
  AiLabelsValue,
  EffortValue,
  HOST_OFFLINE_GRACE_CHOICES,
  HostOfflineGraceValue,
  readSetting,
  writeSetting,
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
    403: errorResponse("这项设置不能修改（主干里不会出现）"),
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
    403: errorResponse("这项设置不能修改（主干里不会出现）"),
  },
});

const HostOfflineGrace = z.object({ seconds: HostOfflineGraceValue }).openapi("HostOfflineGrace", {
  description: `宿主机断线多久以后，把它上面运行中的会话标为失败。可选：${HOST_OFFLINE_GRACE_CHOICES.join("、")} 秒`,
});

const getHostOfflineGraceRoute = createRoute({
  method: "get",
  path: "/host-offline-grace",
  summary: "宿主机断线多久以后把会话标为失败",
  responses: {
    200: { description: "没改过时是 120 秒", ...json(HostOfflineGrace) },
    401: errorResponse("没有登录"),
  },
});

const putHostOfflineGraceRoute = createRoute({
  method: "put",
  path: "/host-offline-grace",
  summary: "修改宿主机断线多久以后把会话标为失败",
  description: "已经断线的宿主机也按新的时长算。",
  request: { body: { ...json(HostOfflineGrace), required: true } },
  responses: {
    200: { description: "改好以后的值", ...json(HostOfflineGrace) },
    400: errorResponse("不支持这个时长"),
    401: errorResponse("没有登录"),
    403: errorResponse("这项设置不能修改（主干里不会出现）"),
  },
});

const locked = apiError("setting_locked", "这项设置不能修改");

/** 设置窗口里的全站设置。 */
export function settingsRoutes(deps: AppDeps, sessions: Sessions) {
  return newRouter()
    .openapi(getAiLabelsRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      return c.json(await readSetting(deps, "ai_labels", { userId: me.id }), 200);
    })
    .openapi(putAiLabelsRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      const value = c.req.valid("json");
      if (!(await writeSetting(deps, "ai_labels", { userId: me.id }, value))) {
        return c.json(locked, 403);
      }
      await sessions.aiLabelsChanged(value);
      return c.json(value, 200);
    })
    .openapi(getDefaultEffortRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      return c.json({ effort: await readSetting(deps, "default_effort", { userId: me.id }) }, 200);
    })
    .openapi(putDefaultEffortRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      const { effort } = c.req.valid("json");
      if (!(await writeSetting(deps, "default_effort", { userId: me.id }, effort))) {
        return c.json(locked, 403);
      }
      return c.json({ effort }, 200);
    })
    .openapi(getHostOfflineGraceRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      const seconds = await readSetting(deps, "host_offline_grace", { userId: me.id });
      return c.json({ seconds }, 200);
    })
    .openapi(putHostOfflineGraceRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      const { seconds } = c.req.valid("json");
      if (!(await writeSetting(deps, "host_offline_grace", { userId: me.id }, seconds))) {
        return c.json(locked, 403);
      }
      return c.json({ seconds }, 200);
    });
}
