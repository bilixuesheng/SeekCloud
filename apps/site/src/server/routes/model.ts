import { createRoute, z } from "@hono/zod-openapi";
import { MODEL_PROTOCOLS, THINKING_EFFORTS } from "@seekcloud/protocol";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app";
import { upstreamErrors } from "../db/schema";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { endpointOf, protocolOf } from "../gateway/trunk";
import { catalogProvider } from "../models/catalog";
import { probeModels } from "../models/probe";
import {
  catalogList,
  createProvider,
  credentialOf,
  deleteProvider,
  ENV_NAME,
  type ModelCatalog,
  PROVIDER_ID,
  type ProviderError,
  providerRow,
  providerRows,
  providerView,
  reorderProviders,
  sessionsUsing,
  updateProvider,
} from "../models/providers";
import { MODEL_INPUTS } from "../models/types";
import { publicNetwork } from "../network/address";
import { jsonBody as json, newRouter } from "./router";

/**
 * 设置的"模型"一类（#113，照 dsh 的"设置 → 模型"）：内置的 DeepSeek、目录里的第三方提供方、自定义接口。
 * key 只写不读：接口只给脱敏预览（models/mask.ts）。以及按参考号查模型服务出错。
 */

const ApiKey = z
  .string()
  .trim()
  .min(1, { error: "请填写 API key" })
  .max(400, { error: "API key 过长" })
  .regex(/^\S+$/, { error: "API key 不能包含空格或换行" });

const BaseUrl = z
  .string()
  .trim()
  .max(500, { error: "地址过长" })
  .refine(
    (v) => {
      try {
        const url = new URL(v);
        return (url.protocol === "https:" || url.protocol === "http:") && !url.username;
      } catch {
        return false;
      }
    },
    { error: "请填写 http:// 或 https:// 开头的地址" },
  );

const EnvName = z
  .string()
  .trim()
  .regex(ENV_NAME, { error: "环境变量名只能包含字母、数字和下划线" });

const ModelSpec = z
  .object({
    id: z.string().trim().min(1, { error: "请填写模型 ID" }).max(200),
    name: z.string().trim().max(100).nullish(),
    contextWindow: z.number().int().min(1).max(100_000_000).nullish(),
    maxTokens: z.number().int().min(1).max(100_000_000).nullish(),
    input: z
      .array(z.enum(MODEL_INPUTS))
      .min(1, { error: "至少保留一种输入类型" })
      .max(MODEL_INPUTS.length),
    reasoningEfforts: z
      .partialRecord(z.enum(THINKING_EFFORTS), z.string().trim().min(1).max(40).nullable())
      .nullish()
      .openapi({
        description: "档位到发给接口的参数值；只有 off 可以是 null（不传）。为空是没声明推理等级",
      }),
    compat: z
      .record(z.string().max(60), z.union([z.boolean(), z.number(), z.string().max(100)]))
      .nullish()
      .openapi({ description: "请求兼容性开关（dsh 的 compat）" }),
  })
  .openapi("ModelSpec");

const ModelSpecView = ModelSpec.extend({
  name: z.string(),
  contextWindow: z.number().int(),
  maxTokens: z.number().int(),
  efforts: z.array(z.enum(THINKING_EFFORTS)),
}).openapi("ModelSpecView");

const Provider = z
  .object({
    id: z.string().openapi({ description: "Provider ID，定了不能改" }),
    name: z.string(),
    kind: z.enum(["deepseek", "catalog", "custom"]),
    api: z.enum(MODEL_PROTOCOLS).nullable(),
    protocols: z.array(z.enum(MODEL_PROTOCOLS)),
    baseUrl: z.string().nullable().openapi({ description: "保存的地址；为空时用 defaultBaseUrl" }),
    defaultBaseUrl: z.string().nullable(),
    enabled: z.boolean(),
    credential: z.object({
      masked: z
        .string()
        .nullable()
        .openapi({ description: "已保存的 key 的脱敏预览；没保存时为空" }),
      env: z.array(z.string()).openapi({ description: "没填 key 时读哪些环境变量" }),
      envDetected: z
        .string()
        .nullable()
        .openapi({ description: "检测到了哪个环境变量：只看有没有值，不验证、不连" }),
      apiKeyEnv: z.string().nullable(),
    }),
    keySetAt: z.string().nullable(),
    keyRejectedAt: z
      .string()
      .nullable()
      .openapi({ description: "上游最近一次说 key 不对的时间；换了 key 以后清掉" }),
    customModels: z.boolean().openapi({ description: "用的是自己改过的模型列表" }),
    models: z.array(ModelSpecView),
  })
  .openapi("ModelProvider", { description: "一个模型提供方，不含 key 的原文" });

const IdParam = z.object({ id: z.string().regex(PROVIDER_ID) });

const listRoute = createRoute({
  method: "get",
  path: "/settings/model-providers",
  summary: "模型提供方",
  responses: {
    200: { description: "按保存的顺序", ...json(z.object({ providers: z.array(Provider) })) },
    401: errorResponse("没有登录"),
  },
});

const catalogRoute = createRoute({
  method: "get",
  path: "/settings/model-providers/catalog",
  summary: "目录里的第三方提供方",
  description: "来自 dsh 用的 @earendil-works/pi-ai 目录（快照）。只列填一个 key 就能用的。",
  responses: {
    200: {
      description: "目录",
      ...json(
        z.object({
          providers: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              env: z.array(z.string()),
              protocols: z.array(z.enum(MODEL_PROTOCOLS)),
              baseUrl: z.string().nullable(),
              models: z.number().int(),
              added: z.boolean(),
              envDetected: z
                .string()
                .nullable()
                .openapi({ description: "检测到了哪个环境变量（只看有没有值）" }),
            }),
          ),
        }),
      ),
    },
    401: errorResponse("没有登录"),
  },
});

const createProviderRoute = createRoute({
  method: "post",
  path: "/settings/model-providers",
  summary: "添加模型提供方",
  description:
    "kind = catalog：从目录里选，id 是目录里的 ID，地址、协议、模型列表由目录给；kind = custom：自定义接口，" +
    "要 Provider ID、地址、协议、至少一个模型。key 加密存放；不填时读环境变量。",
  request: {
    body: {
      ...json(
        z.object({
          kind: z.enum(["catalog", "custom"]),
          id: z.string().regex(PROVIDER_ID, {
            error: "Provider ID 只能包含小写字母、数字和 -，以字母或数字开头",
          }),
          name: z.string().trim().max(60).optional(),
          api: z.enum(MODEL_PROTOCOLS).optional(),
          baseUrl: BaseUrl.nullish(),
          apiKey: ApiKey.optional(),
          apiKeyEnv: EnvName.nullish(),
          models: z.array(ModelSpec).max(1000).optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    201: { description: "添加好的提供方", ...json(Provider) },
    400: errorResponse("格式不对、模型列表不对"),
    401: errorResponse("没有登录"),
    403: errorResponse("这项设置不能修改（主干里不会出现）"),
    404: errorResponse("目录里没有这个提供方"),
    409: errorResponse("Provider ID 已经有了，或者和内置的、目录里的冲突"),
  },
});

const updateProviderRoute = createRoute({
  method: "patch",
  path: "/settings/model-providers/{id}",
  summary: "修改模型提供方",
  description:
    "apiKey 为 null 是删掉已保存的 key（之后读环境变量）；models 是整个替换模型列表；resetModels 是“恢复默认模型”。" +
    "改了 key 下一次请求就用新的，不用重启沙箱。",
  request: {
    params: IdParam,
    body: {
      ...json(
        z.object({
          name: z.string().trim().max(60).optional(),
          api: z.enum(MODEL_PROTOCOLS).optional(),
          baseUrl: BaseUrl.nullish(),
          apiKey: ApiKey.nullish(),
          apiKeyEnv: EnvName.nullish(),
          enabled: z.boolean().optional(),
          models: z.array(ModelSpec).max(1000).optional(),
          resetModels: z.boolean().optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: { description: "改好以后的提供方", ...json(Provider) },
    400: errorResponse("格式不对、模型列表不对"),
    401: errorResponse("没有登录"),
    403: errorResponse("这项设置不能修改（主干里不会出现）"),
    404: errorResponse("没有这个提供方"),
  },
});

const usageRoute = createRoute({
  method: "get",
  path: "/settings/model-providers/{id}/sessions",
  summary: "用着这个提供方的模型的会话有几个",
  description: "删除提供方之前提示。不算已归档的。",
  request: { params: IdParam },
  responses: {
    200: { description: "会话数", ...json(z.object({ sessions: z.number().int() })) },
    401: errorResponse("没有登录"),
    404: errorResponse("没有这个提供方"),
  },
});

const deleteProviderRoute = createRoute({
  method: "delete",
  path: "/settings/model-providers/{id}",
  summary: "删除模型提供方",
  description:
    "连同它的模型列表和 key 一起删。已经跑过的会话保留自己的模型，下一次发消息时提示换一个。内置的 DeepSeek 不能删，只能停用。",
  request: { params: IdParam },
  responses: {
    200: { description: "删好了", ...json(z.object({ ok: z.literal(true) })) },
    401: errorResponse("没有登录"),
    403: errorResponse("这项设置不能修改（主干里不会出现）"),
    404: errorResponse("没有这个提供方"),
    409: errorResponse("内置的 DeepSeek 不能删"),
  },
});

const orderRoute = createRoute({
  method: "put",
  path: "/settings/model-providers/order",
  summary: "调整提供方的先后",
  request: {
    body: {
      ...json(z.object({ order: z.array(z.string().regex(PROVIDER_ID)).max(200) })),
      required: true,
    },
  },
  responses: {
    200: { description: "调整以后的提供方", ...json(z.object({ providers: z.array(Provider) })) },
    401: errorResponse("没有登录"),
    403: errorResponse("这项设置不能修改（主干里不会出现）"),
  },
});

const checkUrlRoute = createRoute({
  method: "post",
  path: "/settings/model-providers/check-url",
  summary: "保存前看一下接口地址",
  description:
    "不是 HTTPS 时提示请求和 key 会以明文发出；解析到内网、本机时提示地址在内网（自己部署的模型可以是内网地址，不拦）。只解析域名，不连。",
  request: { body: { ...json(z.object({ url: BaseUrl })), required: true } },
  responses: {
    200: {
      description: "提示",
      ...json(z.object({ plaintext: z.boolean(), internal: z.boolean() })),
    },
    400: errorResponse("地址格式不对"),
    401: errorResponse("没有登录"),
  },
});

const probeRoute = createRoute({
  method: "post",
  path: "/settings/model-providers/probe",
  summary: "获取可用模型",
  description:
    "用表单里的地址、协议、key 问端点有哪些模型（OpenAI 兼容的 GET /models、Anthropic 的 GET /v1/models、" +
    "Gemini 的 GET /models）；表单里没填的用已保存的。目录里的提供方由目录作答，不发请求。什么都不存。" +
    "报错里认得出来的密钥打码。",
  request: {
    body: {
      ...json(
        z.object({
          id: z.string().regex(PROVIDER_ID).optional().openapi({ description: "已保存的提供方" }),
          api: z.enum(MODEL_PROTOCOLS).optional(),
          baseUrl: BaseUrl.optional(),
          apiKey: ApiKey.optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: {
      description: "端点列出的模型（可能是空的）",
      ...json(
        z.object({
          models: z.array(
            z.object({
              id: z.string(),
              name: z.string().optional(),
              contextWindow: z.number().int().optional(),
              maxTokens: z.number().int().optional(),
            }),
          ),
        }),
      ),
    },
    400: errorResponse("缺协议或地址，或者端点报错、格式不对（说明里有端点的回答，密钥打了码）"),
    401: errorResponse("没有登录"),
    403: errorResponse("这项设置不能修改（主干里不会出现）"),
    404: errorResponse("没有这个提供方"),
  },
});

const errorRoute = createRoute({
  method: "get",
  path: "/model-errors/{ref}",
  summary: "按参考号查一次模型服务出错",
  description:
    "开源版对管理员透明：带着上游的原始报错（ADR 0007 的 2026-11-14 修订）。只给浏览器，不进沙箱。",
  request: { params: z.object({ ref: z.string().max(40) }) },
  responses: {
    200: { description: "出错的内容", ...json(z.record(z.string(), z.unknown())) },
    401: errorResponse("没有登录"),
    404: errorResponse("没有这个参考号，或者已经超过保存期限"),
  },
});

const PROVIDER_ERRORS: Record<ProviderError, { status: 400 | 404 | 409; message: string }> = {
  provider_not_found: { status: 404, message: "该模型提供方不存在" },
  provider_exists: { status: 409, message: "该 Provider ID 已被使用" },
  provider_reserved: {
    status: 409,
    message: "该 Provider ID 与内置或目录中的提供方相同，请换一个",
  },
  provider_builtin: { status: 409, message: "内置的 DeepSeek 不能删除，可以停用" },
  catalog_not_found: { status: 404, message: "目录中没有该提供方" },
  invalid_models: { status: 400, message: "模型列表有误" },
};

const locked = apiError("setting_locked", "这项设置不能修改");

/**
 * changed：提供方改了以后调用（沙箱还开着的会话换上新的配置，#188）。
 */
export function modelRoutes(
  deps: AppDeps,
  models: ModelCatalog,
  changed: () => Promise<void> = async () => {},
) {
  // 发给宿主机的事出了错不挡设置的保存
  const notify = () => void changed().catch((e) => console.error("通知宿主机模型配置失败", e));
  /** 改提供方之前问设置的规则（下游可以不让普通用户改）。 */
  const writable = (userId: string) =>
    Promise.resolve(deps.settingsPolicy.canWrite("model_providers", { userId }));
  const fail = (error: ProviderError, message?: string) => {
    const known = PROVIDER_ERRORS[error];
    return { body: apiError(error, message ?? known.message), status: known.status };
  };
  const views = async () =>
    Promise.all((await providerRows(deps)).map((row) => providerView(deps, models, row)));

  return newRouter()
    .openapi(listRoute, async (c) => {
      if (!(await deps.identity.currentUser(c))) return c.json(notLoggedIn, 401);
      return c.json({ providers: await views() }, 200);
    })
    .openapi(catalogRoute, async (c) => {
      if (!(await deps.identity.currentUser(c))) return c.json(notLoggedIn, 401);
      return c.json({ providers: await catalogList(deps) }, 200);
    })
    .openapi(checkUrlRoute, async (c) => {
      if (!(await deps.identity.currentUser(c))) return c.json(notLoggedIn, 401);
      const url = new URL(c.req.valid("json").url);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const network = deps.outboundNetwork ?? publicNetwork;
      const internal = await network.resolve(host).then(
        (addresses) => addresses.some((a) => !network.allowAddress(a.address)),
        () => false,
      );
      return c.json({ plaintext: url.protocol !== "https:", internal }, 200);
    })
    .openapi(probeRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!(await writable(me.id))) return c.json(locked, 403);
      const form = c.req.valid("json");
      const row = form.id ? await providerRow(deps, form.id) : undefined;
      if (form.id && !row) {
        const { body } = fail("provider_not_found");
        return c.json(body, 404);
      }
      // 目录里的提供方（没改地址时）由目录作答，和 dsh 一样
      if (row?.kind === "catalog" && !form.baseUrl && !row.baseUrl) {
        const listed = catalogProvider(row.slug)?.models ?? [];
        return c.json(
          {
            models: listed.map((m) => ({
              id: m.id,
              name: m.name,
              ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
              ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
            })),
          },
          200,
        );
      }
      const protocol =
        form.api ??
        (row?.kind === "deepseek"
          ? "anthropic-messages"
          : row?.kind === "custom"
            ? row.api
            : row
              ? protocolOf(row, "")
              : undefined);
      if (!protocol) return c.json(apiError("probe_failed", "请选择 API 协议"), 400);
      const baseUrl = form.baseUrl ?? (row ? endpointOf(row, protocol) : undefined);
      if (!baseUrl) return c.json(apiError("probe_failed", "请填写接口地址"), 400);
      const apiKey = form.apiKey ?? (row ? credentialOf(deps, row)?.key : undefined);
      const result = await probeModels(deps, {
        protocol,
        baseUrl,
        apiKey,
        // DeepSeek 的模型列表在域名根下的 /models（和发布的列表同一个接口）
        ...(row?.kind === "deepseek" && !form.baseUrl
          ? { url: new URL("/models", new URL(baseUrl).origin).href }
          : {}),
      });
      if (!result.ok) return c.json(apiError("probe_failed", result.message), 400);
      return c.json({ models: result.models }, 200);
    })
    .openapi(orderRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!(await writable(me.id))) return c.json(locked, 403);
      await reorderProviders(deps, c.req.valid("json").order);
      notify();
      return c.json({ providers: await views() }, 200);
    })
    .openapi(createProviderRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!(await writable(me.id))) return c.json(locked, 403);
      const result = await createProvider(deps, c.req.valid("json"));
      if (!result.ok) {
        const { body, status } = fail(result.error, result.message);
        return c.json(body, status);
      }
      notify();
      return c.json(await providerView(deps, models, result.row), 201);
    })
    .openapi(updateProviderRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!(await writable(me.id))) return c.json(locked, 403);
      const result = await updateProvider(deps, c.req.valid("param").id, c.req.valid("json"));
      if (!result.ok) {
        const { body, status } = fail(result.error, result.message);
        return c.json(body, status as 400 | 404);
      }
      notify();
      return c.json(await providerView(deps, models, result.row), 200);
    })
    .openapi(usageRoute, async (c) => {
      if (!(await deps.identity.currentUser(c))) return c.json(notLoggedIn, 401);
      const { id } = c.req.valid("param");
      if (!(await providerRow(deps, id))) {
        const { body } = fail("provider_not_found");
        return c.json(body, 404);
      }
      return c.json({ sessions: await sessionsUsing(deps, id) }, 200);
    })
    .openapi(deleteProviderRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      if (!(await writable(me.id))) return c.json(locked, 403);
      const result = await deleteProvider(deps, c.req.valid("param").id);
      if (!result.ok) {
        const { body, status } = fail(result.error);
        return c.json(body, status as 404 | 409);
      }
      notify();
      return c.json({ ok: true as const }, 200);
    })
    .openapi(errorRoute, async (c) => {
      const me = await deps.identity.currentUser(c);
      if (!me) return c.json(notLoggedIn, 401);
      const [row] = await deps.db
        .select()
        .from(upstreamErrors)
        .where(
          and(eq(upstreamErrors.ref, c.req.valid("param").ref), eq(upstreamErrors.userId, me.id)),
        );
      if (!row)
        return c.json(apiError("model_error_not_found", "没有这个参考号，或已超过保存期限"), 404);
      const status =
        row.status !== null && row.status >= 400 && row.status <= 599 ? row.status : undefined;
      return c.json(
        deps.errorPresentation.present(
          {
            ref: row.ref,
            code: row.code,
            status,
            provider: row.provider,
            upstream: { status: row.status, body: row.body },
            createdAt: row.createdAt.toISOString(),
          },
          me,
        ),
        200,
      );
    });
}
