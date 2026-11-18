import { eq, lt } from "drizzle-orm";
import type { AppDeps } from "../app";
import { modelProviders, modelUsage, upstreamErrors, webToolUsage } from "../db/schema";
import type { ErrorPresentation, ModelAdmission, ProviderRouting, ProviderTarget } from "../ports";
import { findModel } from "../sessions/models";

/** DeepSeek 官方：主干唯一的提供方。 */
export const DEEPSEEK = {
  slug: "deepseek",
  name: "DeepSeek 官方",
  baseUrl: "https://api.deepseek.com/anthropic",
} as const;

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

type ProviderDeps = Pick<AppDeps, "db" | "secrets" | "version">;

/** 提供方的 key 现在的状态（给设置页看，不含原文）。 */
export async function providerStatus(deps: Pick<AppDeps, "db">) {
  const [row] = await deps.db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.slug, DEEPSEEK.slug));
  return {
    name: row?.name ?? DEEPSEEK.name,
    keySet: Boolean(row?.apiKey),
    keySetAt: row?.keySetAt?.toISOString() ?? null,
    keyRejectedAt: row?.keyRejectedAt?.toISOString() ?? null,
  };
}

/** 填写或替换 DeepSeek 的 key：加密存放；之前"key 被拒绝"的提示清掉。 */
export async function setProviderKey(
  deps: Pick<AppDeps, "db" | "secrets" | "clock">,
  apiKey: string,
): Promise<void> {
  const now = deps.clock.now();
  const sealed = deps.secrets.seal(apiKey);
  await deps.db
    .insert(modelProviders)
    .values({ ...DEEPSEEK, apiKey: sealed, keySetAt: now, createdAt: now })
    .onConflictDoUpdate({
      target: modelProviders.slug,
      set: { apiKey: sealed, keySetAt: now, keyRejectedAt: null },
    });
}

/** 删除 key：之后发起会话会提示先填 key。 */
export async function deleteProviderKey(deps: Pick<AppDeps, "db">): Promise<void> {
  await deps.db
    .update(modelProviders)
    .set({ apiKey: null, keySetAt: null, keyRejectedAt: null })
    .where(eq(modelProviders.slug, DEEPSEEK.slug));
}

/** 上游说 key 不对（401、403）：记下时间，设置里提示管理员检查。 */
export async function markProviderKeyRejected(
  deps: Pick<AppDeps, "db" | "clock">,
  provider: string,
): Promise<void> {
  await deps.db
    .update(modelProviders)
    .set({ keyRejectedAt: deps.clock.now() })
    .where(eq(modelProviders.slug, provider));
}

/** DeepSeek 的联网搜索、抓取接口在接口地址的同一个域名下，路径是 /v1/tools/…（和 dsh 的约定一样）。 */
const TOOLS_PREFIX = "/v1/tools/";

/**
 * 用存着的 key 建一个 DeepSeek 官方的上游；没填 key（或者解不开）时为空。
 * model 是 Messages 请求换成的上游模型名（我们的模型 ID 就是 DeepSeek 的模型名）。
 */
async function deepseekTarget(
  deps: ProviderDeps,
  model?: string,
): Promise<ProviderTarget | undefined> {
  const [row] = await deps.db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.slug, DEEPSEEK.slug));
  if (!row?.apiKey) return undefined;
  const apiKey = deps.secrets.open(row.apiKey);
  if (apiKey === undefined) {
    // 换过 SEEKCLOUD_SECRET_KEY，旧的密文解不开：当作没填，管理员重新填一次。
    console.warn(
      "模型服务的 API key 无法解密（SEEKCLOUD_SECRET_KEY 可能换过），请在设置里重新填写",
    );
    return undefined;
  }
  const base = row.baseUrl.replace(/\/+$/, "");
  const origin = new URL(base).origin;
  const headers = (path: string, incoming: Headers) => {
    const out = new Headers({ "user-agent": `SeekCloud/${deps.version}` });
    // 联网工具认 Authorization: Bearer，Messages 和 Files 认 x-api-key。
    if (path.startsWith(TOOLS_PREFIX)) {
      out.set("authorization", `Bearer ${apiKey}`);
      return out;
    }
    out.set("x-api-key", apiKey);
    for (const name of FORWARDED_HEADERS) {
      const value = incoming.get(name);
      if (value) out.set(name, value);
    }
    if (!out.has("anthropic-version")) out.set("anthropic-version", DEFAULT_ANTHROPIC_VERSION);
    return out;
  };
  return {
    provider: row.slug,
    url: (path) => (path.startsWith(TOOLS_PREFIX) ? `${origin}${path}` : `${base}${path}`),
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
 * 主干的提供方路由：只有 DeepSeek 官方一个，没填 key 时没有可用的。
 * 我们的模型 ID 就是 DeepSeek 官方的模型名（和 dsh 的模型目录一致），不用换。
 * Files 和联网搜索也走 DeepSeek 官方，用同一把 key。
 */
export function deepseekRouting(deps: ProviderDeps): ProviderRouting {
  return {
    async route(model) {
      if (!findModel(model)) return [];
      const target = await deepseekTarget(deps, model);
      return target ? [target] : [];
    },
    async service() {
      const target = await deepseekTarget(deps);
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
