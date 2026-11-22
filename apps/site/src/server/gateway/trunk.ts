import { DEEPSEEK_PROVIDER, type ModelProtocol, parseModelRef } from "@seekcloud/protocol";
import { lt } from "drizzle-orm";
import type { AppDeps } from "../app";
import { modelUsage, upstreamErrors, webToolUsage } from "../db/schema";
import { catalogProvider, DEEPSEEK } from "../models/catalog";
import { credentialOf, ModelCatalog, type ProviderRow, providerRow } from "../models/providers";
import type { ErrorPresentation, ModelAdmission, ProviderRouting, ProviderTarget } from "../ports";

export { DEEPSEEK };

/** 发给上游的请求头只留这几个，其余的（包括 dsh 的 x-deepseek-harness-*）一律不带。 */
const FORWARDED_HEADERS = ["anthropic-version", "anthropic-beta"];
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * 剥掉 dsh 夹带的字段：顶层的 dsh_*（会话日志、插件清单这些）和 metadata 里的 user_id。
 * 只看顶层和 metadata：消息内容、工具参数里出现 dsh_ 开头的键是用户自己的数据，不能动。
 */
export function stripHarnessFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("dsh_")) continue;
    out[key] = value;
  }
  if (typeof out.metadata === "object" && out.metadata !== null) {
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out.metadata as Record<string, unknown>)) {
      if (key === "user_id" || key.startsWith("dsh_")) continue;
      metadata[key] = value;
    }
    if (Object.keys(metadata).length > 0) out.metadata = metadata;
    else delete out.metadata;
  }
  return out;
}

type ProviderDeps = Pick<AppDeps, "db" | "secrets" | "version" | "clock" | "settingsPolicy"> & {
  env?: Record<string, string | undefined>;
};

/** DeepSeek 的联网搜索、抓取接口在接口地址的同一个域名下，路径是 /v1/tools/…（和 dsh 的约定一样）。 */
const TOOLS_PREFIX = "/v1/tools/";

/**
 * 认证头按协议放（#113）：OpenAI 系是 Authorization: Bearer，Anthropic 是 x-api-key，Gemini 是
 * x-goog-api-key。Anthropic 的 anthropic-version、anthropic-beta 照转，别的请求头一律不带。
 */
export function authHeaders(
  protocol: ModelProtocol,
  apiKey: string,
  incoming: Headers,
  version: string,
): Headers {
  const out = new Headers({ "user-agent": `SeekCloud/${version}` });
  if (protocol === "anthropic-messages") {
    out.set("x-api-key", apiKey);
    for (const name of FORWARDED_HEADERS) {
      const value = incoming.get(name);
      if (value) out.set(name, value);
    }
    if (!out.has("anthropic-version")) out.set("anthropic-version", DEFAULT_ANTHROPIC_VERSION);
  } else if (protocol === "google-generative-ai") {
    out.set("x-goog-api-key", apiKey);
  } else {
    out.set("authorization", `Bearer ${apiKey}`);
  }
  return out;
}

/** 提供方的某种协议发到哪个地址：管理员填的地址优先，目录里的用目录给的。 */
export function endpointOf(row: ProviderRow, protocol: ModelProtocol): string | undefined {
  if (row.baseUrl) return row.baseUrl;
  if (row.kind === "deepseek") return DEEPSEEK.baseUrl;
  if (row.kind === "catalog") return catalogProvider(row.slug)?.endpoints[protocol];
  return undefined;
}

/** 一个模型用哪种协议：DeepSeek 是 Anthropic Messages，目录里的照目录，自定义接口照设置。 */
export function protocolOf(row: ProviderRow, model: string): ModelProtocol {
  if (row.kind === "deepseek") return "anthropic-messages";
  if (row.kind === "catalog") {
    const listed = catalogProvider(row.slug);
    const known = listed?.models.find((m) => m.id === model)?.api;
    return (
      known ??
      (Object.keys(listed?.endpoints ?? {})[0] as ModelProtocol | undefined) ??
      "openai-completions"
    );
  }
  return row.api ?? "openai-completions";
}

/** 一个提供方、一种协议的上游。key 每次请求时现读（改了 key 下一次请求就用新的）。 */
function targetOf(
  deps: ProviderDeps,
  row: ProviderRow,
  protocol: ModelProtocol,
  apiKey: string,
  model?: string,
): ProviderTarget | undefined {
  const endpoint = endpointOf(row, protocol);
  if (!endpoint) return undefined;
  const base = endpoint.replace(/\/+$/, "");
  const origin = new URL(base).origin;
  const deepseek = row.kind === "deepseek";
  const tools = (path: string) => deepseek && path.startsWith(TOOLS_PREFIX);
  // DeepSeek 的联网工具认 Authorization: Bearer，Messages 和 Files 认 x-api-key
  const headers = (path: string, incoming: Headers) =>
    authHeaders(tools(path) ? "openai-completions" : protocol, apiKey, incoming, deps.version);
  return {
    provider: row.slug,
    protocol,
    url: (path) => (tools(path) ? `${origin}${path}` : `${base}${path}`),
    headers,
    prepare: ({ headers: incoming, body }) => {
      const out = headers("/v1/messages", incoming);
      out.set("content-type", "application/json");
      const stripped = stripHarnessFields(body);
      return { headers: out, body: model ? { ...stripped, model } : stripped };
    },
  };
}

/**
 * 主干的提供方路由：按设置里的提供方（#113）。模型 ID 是"提供方/模型"，发给上游时换成模型本身的 ID。
 * 提供方停用了、没有 key（也没有环境变量）、模型不在它的列表里时没有可用的。Files 和联网搜索只有
 * DeepSeek 官方有。models 和 createApp 用同一个（main.ts），不填时自己建一个不取 DeepSeek 发布列表的。
 */
export function configuredRouting(
  deps: ProviderDeps,
  models: Pick<ModelCatalog, "find"> = new ModelCatalog(deps),
): ProviderRouting {
  const resolve = async (slug: string) => {
    const row = await providerRow(deps, slug);
    if (!row?.enabled) return undefined;
    const credential = credentialOf(deps, row);
    return credential ? { row, key: credential.key } : undefined;
  };
  return {
    async route(ref) {
      const { provider, model } = parseModelRef(ref);
      const found = await resolve(provider);
      if (!found || !(await models.find(ref))) return [];
      const target = targetOf(deps, found.row, protocolOf(found.row, model), found.key, model);
      return target ? [target] : [];
    },
    async service() {
      const found = await resolve(DEEPSEEK_PROVIDER);
      const target = found && targetOf(deps, found.row, "anthropic-messages", found.key);
      return target ? [target] : [];
    },
  };
}

/** 主干的准入和记录：一律放行，每次调用写一条用量。 */
export function usageAdmission(deps: Pick<AppDeps, "db" | "clock">): ModelAdmission {
  return {
    admit: async () => ({ ok: true }),
    admitWebTool: async () => ({ ok: true }),
    async recordWebTool(usage) {
      await deps.db.insert(webToolUsage).values({
        userId: usage.userId,
        sessionId: usage.sessionId,
        turnId: usage.turnId,
        tool: usage.tool,
        provider: usage.provider,
        ok: usage.ok,
        createdAt: deps.clock.now(),
      });
    },
    async record(usage) {
      await deps.db.insert(modelUsage).values({
        userId: usage.userId,
        sessionId: usage.sessionId,
        turnId: usage.turnId,
        purpose: usage.purpose,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        complete: usage.complete,
        createdAt: deps.clock.now(),
      });
    },
  };
}

/** 主干的报错呈现：管理员看到全部，包括上游的原始报错（ADR 0007 的 2026-11-14 修订）。 */
export const transparentErrors: ErrorPresentation = {
  present: (failure) => ({
    ref: failure.ref,
    code: failure.code,
    status: failure.status ?? null,
    provider: failure.provider,
    upstream: failure.upstream,
    createdAt: failure.createdAt,
  }),
};

/** 上游的原始报错保存 30 天。 */
export const UPSTREAM_ERROR_RETENTION_DAYS = 30;

/** 删掉满 30 天的上游原始报错（定期任务，maintenance.ts）。 */
export async function purgeUpstreamErrors(deps: Pick<AppDeps, "db" | "clock">): Promise<void> {
  const cutoff = new Date(
    deps.clock.now().getTime() - UPSTREAM_ERROR_RETENTION_DAYS * 24 * 60 * 60_000,
  );
  await deps.db.delete(upstreamErrors).where(lt(upstreamErrors.createdAt, cutoff));
}
