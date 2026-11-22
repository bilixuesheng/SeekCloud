import { createRoute, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { canSkipThinking, platformCallCost } from "../models/providers";
import { normalizeModelRef, type Sessions } from "../sessions/sessions";
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

const PlatformModel = z.object({ model: z.string().max(300) }).openapi("PlatformModel", {
  description:
    "平台自己发起的模型调用（判断会话是否在等你输入这些）用哪个模型：提供方/模型（/api/models 的 id），或者 auto（自动，用能用的模型里最省的那个）。",
});

const DefaultModel = z.object({ model: z.string().max(300) }).openapi("DefaultModel", {
  description:
    "新会话默认的模型（提供方/模型）。模型选择器里选了就记下（照 dsh）；空字符串是没选过，用第一个能用的模型。",
});

const getDefaultModelRoute = createRoute({
  method: "get",
  path: "/default-model",
  summary: "新会话默认的模型",
  responses: {
    200: { description: "没选过时是空字符串", ...json(DefaultModel) },
    401: errorResponse("没有登录"),
  },
});

const putDefaultModelRoute = createRoute({
  method: "put",
  path: "/default-model",
  summary: "修改新会话默认的模型",
  request: { body: { ...json(DefaultModel), required: true } },
  responses: {
    200: { description: "改好以后的值", ...json(DefaultModel) },
    400: errorResponse("不支持这个模型"),
    401: errorResponse("没有登录"),
    403: errorResponse("这项设置不能修改（主干里不会出现）"),
  },
});

const PlatformCandidate = z
  .object({
    ref: z.string(),
    name: z.string(),
    providerName: z.string(),
    cost: z
      .tuple([z.number(), z.number()])
      .nullable()
      .openapi({ description: "每百万 token 的输入、输出价格（美元）；不知道时为空" }),
    callCost: z.number().nullable().openapi({
      description: "估一次平台调用的价钱（美元，约 2000 个输入 token、20 个输出 token）",
    }),
    canSkipThinking: z.boolean().openapi({ description: "能不能关掉思考" }),
  })
  .openapi("PlatformCandidate");

const PlatformModelState = PlatformModel.extend({
  resolved: z
    .string()
    .nullable()
    .openapi({ description: "现在实际用的模型（提供方/模型）；一个能用的模型都没有时为空" }),
  basis: z.enum(["chosen", "price", "order", "none"]).openapi({
    description:
      "chosen：用的是选的那个；price：自动，按目录或填写的价格挑了最省的；order：自动，没有价格，按列表顺序用了第一个；none：没有能用的模型",
  }),
  candidates: z.array(PlatformCandidate).openapi({ description: "能选的模型，按提供方和列表顺序" }),
}).openapi("PlatformModelState");

const getPlatformModelRoute = createRoute({
  method: "get",
  path: "/platform-model",
  summary: "平台自己发起的模型调用用哪个模型",
  description: "连同现在实际用的是哪个、为什么，以及每个能选的模型的价格。",
  responses: {
    200: { description: "没改过时是 auto", ...json(PlatformModelState) },
    401: errorResponse("没有登录"),
  },
});

const putPlatformModelRoute = createRoute({
  method: "put",
  path: "/platform-model",
  summary: "修改平台自己发起的模型调用用哪个模型",
  request: { body: { ...json(PlatformModel), required: true } },
  responses: {
    200: { description: "改好以后的值", ...json(PlatformModelState) },
    400: errorResponse("不支持这个模型"),
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
    })
    .openapi(getDefaultModelRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      return c.json({ model: await readSetting(deps, "default_model", { userId: me.id }) }, 200);
    })
    .openapi(putDefaultModelRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      const { model } = c.req.valid("json");
      const chosen = model && normalizeModelRef(model);
      if (chosen && !(await sessions.models.find(chosen))) {
        return c.json(apiError("unknown_model", "不支持这个模型"), 400);
      }
      if (!(await writeSetting(deps, "default_model", { userId: me.id }, chosen))) {
        return c.json(locked, 403);
      }
      return c.json({ model: chosen }, 200);
    })
    .openapi(getPlatformModelRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      return c.json(await platformState(me.id), 200);
    })
    .openapi(putPlatformModelRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      const { model } = c.req.valid("json");
      const chosen = model === "auto" ? model : normalizeModelRef(model);
      if (chosen !== "auto" && !(await sessions.models.find(chosen))) {
        return c.json(apiError("unknown_model", "不支持这个模型"), 400);
      }
      if (!(await writeSetting(deps, "platform_model", { userId: me.id }, chosen))) {
        return c.json(locked, 403);
      }
      return c.json(await platformState(me.id), 200);
    });

  /** 平台调用的模型：设置的值、现在实际用的、怎么挑的、能选的模型和价格。 */
  async function platformState(userId: string) {
    const models = sessions.models;
    const [model, choice, available] = await Promise.all([
      readSetting(deps, "platform_model", { userId }),
      models.platformChoice(userId),
      models.available(),
    ]);
    return {
      model,
      resolved: choice.model?.ref ?? null,
      basis: choice.basis,
      candidates: available.flatMap(({ row, models: list }) =>
        list.map((m) => ({
          ref: m.ref,
          name: m.name,
          providerName: row.name,
          cost: m.cost,
          callCost: platformCallCost(m) ?? null,
          canSkipThinking: canSkipThinking(m),
        })),
      ),
    };
  }
}
