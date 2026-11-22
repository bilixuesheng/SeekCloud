import {
  DEEPSEEK_PROVIDER,
  type ModelProtocol,
  modelRef,
  parseModelRef,
  THINKING_EFFORTS,
  type ThinkingEffort,
} from "@seekcloud/protocol";
import { and, asc, eq, inArray, like, ne, sql } from "drizzle-orm";
import type { AppDeps } from "../app";
import { modelProviders, providerModels, sessions } from "../db/schema";
import { readSetting } from "../settings";
import {
  CATALOG,
  type CatalogProvider,
  catalogProvider,
  DEEPSEEK,
  DEEPSEEK_EFFORTS,
  DEEPSEEK_MODELS,
} from "./catalog";
import { DeepSeekListing } from "./deepseek-listing";
import { maskKey } from "./mask";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  type ModelCompat,
  type ModelEntry,
  type ModelSpec,
  type ReasoningEfforts,
} from "./types";

/**
 * 提供方和模型（#113，照 dsh 的"设置 → 模型"）：设置页的读写、凭据、模型列表。
 * 模型列表的来源：DeepSeek 跟着它发布的列表（取不到用内置的两个），目录里的提供方跟着目录，
 * 自己改过列表的（custom_models）用 provider_models 里的行。
 */

export type ProviderRow = typeof modelProviders.$inferSelect;
export type ModelsDeps = Pick<AppDeps, "db" | "secrets" | "clock" | "settingsPolicy"> & {
  env?: Record<string, string | undefined>;
};

/** Provider ID：小写字母、数字、-，字母或数字开头。 */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** 环境变量名。 */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

const envOf = (deps: { env?: Record<string, string | undefined> }) => deps.env ?? process.env;

export async function providerRows(deps: Pick<AppDeps, "db">): Promise<ProviderRow[]> {
  return deps.db
    .select()
    .from(modelProviders)
    .orderBy(asc(modelProviders.position), asc(modelProviders.createdAt));
}

export async function providerRow(
  deps: Pick<AppDeps, "db">,
  slug: string,
): Promise<ProviderRow | undefined> {
  const [row] = await deps.db.select().from(modelProviders).where(eq(modelProviders.slug, slug));
  return row;
}

/** 没填 key 时读哪些环境变量（按先后）。 */
export function envNames(row: Pick<ProviderRow, "kind" | "slug" | "apiKeyEnv">): string[] {
  if (row.kind === "deepseek") return [DEEPSEEK.env];
  if (row.kind === "catalog") return catalogProvider(row.slug)?.env ?? [];
  return row.apiKeyEnv ? [row.apiKeyEnv] : [];
}

type CredentialDeps = Pick<AppDeps, "secrets"> & { env?: Record<string, string | undefined> };

/** 已保存的 key（解不开时当作没填：换过 SEEKCLOUD_SECRET_KEY，管理员重新填一次）。 */
function savedKey(deps: CredentialDeps, row: ProviderRow): string | undefined {
  if (!row.apiKey) return undefined;
  const key = deps.secrets.open(row.apiKey);
  if (key === undefined) {
    console.warn(
      `模型提供方 ${row.slug} 的 API key 无法解密（SEEKCLOUD_SECRET_KEY 可能换过），请在设置里重新填写`,
    );
  }
  return key;
}

/** 现在用哪把 key：已保存的优先，没有就读环境变量。都没有时为空。 */
export function credentialOf(
  deps: CredentialDeps,
  row: ProviderRow,
): { key: string; source: "saved" | "env"; env?: string } | undefined {
  const saved = savedKey(deps, row);
  if (saved) return { key: saved, source: "saved" };
  const env = envOf(deps);
  for (const name of envNames(row)) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: "env", env: name };
  }
  return undefined;
}

/** 推理等级的声明换成模型选择器里的档位，从低到高。 */
export function effortsOf(declared: ReasoningEfforts | null | undefined): ThinkingEffort[] {
  if (!declared) return [];
  return THINKING_EFFORTS.filter((level) => level in declared);
}

/** 目录里的提供方的每个模型用哪种协议：目录里写着的，不认识的模型用这个提供方的第一种协议。 */
function catalogApi(provider: CatalogProvider | undefined, id: string): ModelProtocol {
  const known = provider?.models.find((m) => m.id === id)?.api;
  if (known) return known;
  const first = provider && (Object.keys(provider.endpoints)[0] as ModelProtocol | undefined);
  return first ?? "openai-completions";
}

/** 自己的列表里的一行整理成 ModelEntry。 */
function fromSpec(row: ProviderRow, spec: typeof providerModels.$inferSelect): ModelEntry {
  const catalog = row.kind === "catalog" ? catalogProvider(row.slug) : undefined;
  const known = catalog?.models.find((m) => m.id === spec.modelId);
  const api: ModelProtocol =
    row.kind === "deepseek"
      ? "anthropic-messages"
      : row.kind === "catalog"
        ? catalogApi(catalog, spec.modelId)
        : (row.api ?? "openai-completions");
  const efforts =
    row.kind === "deepseek"
      ? DEEPSEEK_EFFORTS
      : spec.reasoningEfforts
        ? effortsOf(spec.reasoningEfforts)
        : known && known.efforts.length > 1
          ? known.efforts
          : [];
  return {
    ref: modelRef(row.slug, spec.modelId),
    provider: row.slug,
    id: spec.modelId,
    name: spec.name || known?.name || spec.modelId,
    api,
    contextWindow: spec.contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS,
    input: spec.input.length > 0 ? spec.input : (known?.input ?? ["text"]),
    efforts,
    cost: known?.cost ?? null,
  };
}

/** 目录里的一个模型整理成 ModelEntry。只有 off 一档的（不推理）不显示思考强度。 */
function fromCatalog(slug: string, model: CatalogProvider["models"][number]): ModelEntry {
  return {
    ref: modelRef(slug, model.id),
    provider: slug,
    id: model.id,
    name: model.name,
    api: model.api,
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    input: model.input,
    efforts: model.efforts.length > 1 ? model.efforts : [],
    cost: model.cost,
  };
}

/**
 * 主站这边的模型目录：哪些提供方能用、各自有哪些模型。DeepSeek 发布的列表有缓存（DeepSeekListing），
 * 所以整个主站共用一个实例（app.ts 里建）。
 */
export class ModelCatalog {
  readonly #deps: ModelsDeps;
  readonly #listing: DeepSeekListing | undefined;

  constructor(deps: ModelsDeps, listing?: DeepSeekListing) {
    this.#deps = deps;
    this.#listing = listing;
  }

  /** 一个提供方现在的模型列表（不看有没有 key、有没有停用）。 */
  async modelsOf(row: ProviderRow): Promise<ModelEntry[]> {
    if (row.customModels) {
      const specs = await this.#deps.db
        .select()
        .from(providerModels)
        .where(eq(providerModels.providerId, row.id))
        .orderBy(asc(providerModels.position));
      return specs.map((spec) => fromSpec(row, spec));
    }
    if (row.kind === "deepseek") {
      const credential = credentialOf(this.#deps, row);
      // 改过接口地址的不去取发布的列表（和 dsh 一样：只有官方地址才跟着发布的列表）
      const official = !row.baseUrl || row.baseUrl === DEEPSEEK.baseUrl;
      if (credential && official && this.#listing) return this.#listing.models(credential.key);
      return DEEPSEEK_MODELS;
    }
    if (row.kind === "catalog") {
      return (catalogProvider(row.slug)?.models ?? []).map((m) => fromCatalog(row.slug, m));
    }
    return [];
  }

  /** 能用的模型：启用了、有 key（或者环境变量）的提供方的，按提供方和保存的顺序。 */
  async available(): Promise<Array<{ row: ProviderRow; models: ModelEntry[] }>> {
    const out = [];
    for (const row of await providerRows(this.#deps)) {
      if (!row.enabled || !credentialOf(this.#deps, row)) continue;
      out.push({ row, models: await this.modelsOf(row) });
    }
    return out;
  }

  /** 按"提供方/模型"找一个能用的模型。 */
  async find(ref: string): Promise<ModelEntry | undefined> {
    const { provider, model } = parseModelRef(ref);
    const row = await providerRow(this.#deps, provider);
    if (!row?.enabled || !credentialOf(this.#deps, row)) return undefined;
    return (await this.modelsOf(row)).find((m) => m.id === model);
  }

  /** 新会话默认用哪个模型：设置里的默认模型还能用就用它，不然用第一个能用的。一个都没有时为空。 */
  async defaultModel(userId: string): Promise<ModelEntry | undefined> {
    const chosen = await readSetting(this.#deps, "default_model", { userId });
    if (chosen) {
      const found = await this.find(chosen);
      if (found) return found;
    }
    return (await this.available()).flatMap((p) => p.models)[0];
  }

  /**
   * 平台自己发起的调用用哪个模型：设置里选了、还能用就用它；"自动"（或者选的不在了）用最省的那个
   * （有价钱的里面挑输入加输出最便宜的，都没有价钱就用第一个）。
   */
  async platformModel(userId: string): Promise<ModelEntry | undefined> {
    const chosen = await readSetting(this.#deps, "platform_model", { userId });
    if (chosen !== "auto") {
      const found = await this.find(chosen);
      if (found) return found;
    }
    const all = (await this.available()).flatMap((p) => p.models);
    const priced = all.filter((m) => m.cost);
    const price = (m: ModelEntry) => (m.cost ? m.cost[0] + m.cost[1] : Infinity);
    return [...priced].sort((a, b) => price(a) - price(b))[0] ?? all[0];
  }
}

/**
 * 建主站共用的模型目录：DeepSeek 发布的列表照 deps.deepseekListing（默认开，false 时只用内置的两个），
 * 用 modelFetch 去取。main.ts 和测试里建一个，路由和 createApp 共用。
 */
export function createModelCatalog(
  deps: ModelsDeps & Pick<AppDeps, "modelFetch" | "version" | "deepseekListing">,
): ModelCatalog {
  const listing = deps.deepseekListing;
  return new ModelCatalog(
    deps,
    listing === false
      ? undefined
      : new DeepSeekListing({
          fetch: deps.modelFetch ?? fetch,
          now: () => deps.clock.now().getTime(),
          userAgent: `SeekCloud/${deps.version}`,
          ...listing,
        }),
  );
}

// —— 设置页的读写 ——

/** 设置页上一个提供方的样子：不含 key 的原文。 */
export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderRow["kind"];
  /** 自定义接口的协议；目录里的提供方是它的模型用到的协议。 */
  api: ModelProtocol | null;
  protocols: ModelProtocol[];
  /** 保存的接口地址；为空时用 defaultBaseUrl。 */
  baseUrl: string | null;
  defaultBaseUrl: string | null;
  enabled: boolean;
  credential: {
    /** 已保存的 key 的脱敏预览；没保存时为空。 */
    masked: string | null;
    /** 没填 key 时读哪些环境变量。 */
    env: string[];
    /** 检测到了哪个环境变量（只看有没有值，不验证）。 */
    envDetected: string | null;
    /** 自定义接口填的环境变量名。 */
    apiKeyEnv: string | null;
  };
  keySetAt: string | null;
  keyRejectedAt: string | null;
  /** 用的是自己改过的模型列表（"恢复默认模型"能退回目录或发布的列表）。 */
  customModels: boolean;
  /** 设置页上列的模型：自己的列表；没改过时是目录的（DeepSeek 是内置的两个，和 dsh 一样）。 */
  models: ModelSpecView[];
}

/** 设置页上的一个模型：没填的项是用上的默认值。 */
export interface ModelSpecView {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: ModelEntry["input"];
  reasoningEfforts: ReasoningEfforts | null;
  compat: ModelCompat | null;
  efforts: ThinkingEffort[];
}

const specViewOf = (entry: ModelEntry, spec?: ModelSpec): ModelSpecView => ({
  id: entry.id,
  name: entry.name,
  contextWindow: entry.contextWindow,
  maxTokens: entry.maxTokens,
  input: entry.input,
  reasoningEfforts:
    spec?.reasoningEfforts ??
    (entry.efforts.length > 0 ? Object.fromEntries(entry.efforts.map((e) => [e, e])) : null),
  compat: spec?.compat ?? null,
  efforts: entry.efforts,
});

export async function providerView(
  deps: ModelsDeps,
  catalog: ModelCatalog,
  row: ProviderRow,
): Promise<ProviderView> {
  const env = envNames(row);
  const values = envOf(deps);
  const listed = catalogProvider(row.slug);
  const protocols: ModelProtocol[] =
    row.kind === "deepseek"
      ? ["anthropic-messages"]
      : row.kind === "catalog"
        ? (Object.keys(listed?.endpoints ?? {}) as ModelProtocol[])
        : row.api
          ? [row.api]
          : [];
  let models: ModelSpecView[];
  if (row.customModels) {
    const specs = await deps.db
      .select()
      .from(providerModels)
      .where(eq(providerModels.providerId, row.id))
      .orderBy(asc(providerModels.position));
    models = specs.map((spec) =>
      specViewOf(fromSpec(row, spec), {
        id: spec.modelId,
        input: spec.input,
        reasoningEfforts: spec.reasoningEfforts,
        compat: spec.compat,
      }),
    );
  } else if (row.kind === "deepseek") {
    models = DEEPSEEK_MODELS.map((m) => specViewOf(m));
  } else {
    models = (await catalog.modelsOf(row)).map((m) => specViewOf(m));
  }
  const saved = row.apiKey ? deps.secrets.open(row.apiKey) : undefined;
  return {
    id: row.slug,
    name: row.name,
    kind: row.kind,
    api: row.kind === "custom" ? row.api : (protocols[0] ?? null),
    protocols,
    baseUrl: row.baseUrl,
    defaultBaseUrl:
      row.kind === "deepseek"
        ? DEEPSEEK.baseUrl
        : row.kind === "catalog"
          ? (Object.values(listed?.endpoints ?? {})[0] ?? null)
          : null,
    enabled: row.enabled,
    credential: {
      masked: saved ? maskKey(saved) : null,
      env,
      envDetected: env.find((name) => Boolean(values[name]?.trim())) ?? null,
      apiKeyEnv: row.apiKeyEnv,
    },
    keySetAt: row.keySetAt?.toISOString() ?? null,
    keyRejectedAt: row.keyRejectedAt?.toISOString() ?? null,
    customModels: row.customModels,
    models,
  };
}

export type ProviderError =
  | "provider_not_found"
  | "provider_exists"
  | "provider_reserved"
  | "provider_builtin"
  | "catalog_not_found"
  | "invalid_models";

/** 模型列表的检查：ID 不重复，推理等级至少一个 off 以外的、只有 off 能留空。 */
export function checkModels(models: ModelSpec[]): string | undefined {
  const ids = new Set<string>();
  for (const m of models) {
    if (ids.has(m.id)) return `模型 ${m.id} 重复`;
    ids.add(m.id);
    if (m.input.length === 0) return `模型 ${m.id} 至少要保留一种输入类型`;
    if (m.reasoningEfforts) {
      const levels = Object.entries(m.reasoningEfforts);
      if (!levels.some(([level]) => level !== "off")) {
        return `模型 ${m.id} 的推理等级至少要有一个"关闭"以外的档位`;
      }
      for (const [level, value] of levels) {
        if (value === null && level !== "off") {
          return `模型 ${m.id} 的推理等级"${level}"要填参数值`;
        }
      }
    }
  }
  return undefined;
}

/** 整个替换一个提供方自己的模型列表。 */
async function replaceModels(
  tx: Pick<AppDeps, "db">["db"],
  providerId: string,
  models: ModelSpec[],
): Promise<void> {
  await tx.delete(providerModels).where(eq(providerModels.providerId, providerId));
  if (models.length === 0) return;
  await tx.insert(providerModels).values(
    models.map((m, position) => ({
      providerId,
      modelId: m.id,
      name: m.name?.trim() || null,
      contextWindow: m.contextWindow ?? null,
      maxTokens: m.maxTokens ?? null,
      input: m.input,
      reasoningEfforts: m.reasoningEfforts ?? null,
      compat: m.compat ?? null,
      position,
    })),
  );
}

export interface NewProvider {
  kind: "catalog" | "custom";
  id: string;
  name?: string;
  api?: ModelProtocol;
  baseUrl?: string | null;
  apiKey?: string;
  apiKeyEnv?: string | null;
  models?: ModelSpec[];
}

/** 添加一个提供方：目录里的（id 是目录里的 ID）或者自定义接口。 */
export async function createProvider(
  deps: ModelsDeps,
  input: NewProvider,
): Promise<{ ok: true; row: ProviderRow } | { ok: false; error: ProviderError; message?: string }> {
  if (input.kind === "catalog" && !catalogProvider(input.id)) {
    return { ok: false, error: "catalog_not_found" };
  }
  // 自定义接口不能用内置的、目录里的 ID：沙箱里的 dsh 按 ID 认提供方，会和目录里的混在一起
  if (input.kind === "custom" && (input.id === DEEPSEEK_PROVIDER || catalogProvider(input.id))) {
    return { ok: false, error: "provider_reserved" };
  }
  if (input.kind === "custom" && (!input.models || input.models.length === 0)) {
    return { ok: false, error: "invalid_models", message: "请至少添加一个模型" };
  }
  const invalid = input.models ? checkModels(input.models) : undefined;
  if (invalid) return { ok: false, error: "invalid_models", message: invalid };
  if (await providerRow(deps, input.id)) return { ok: false, error: "provider_exists" };
  const now = deps.clock.now();
  const [last] = await deps.db
    .select({ position: sql<number>`coalesce(max(${modelProviders.position}), 0)` })
    .from(modelProviders);
  const listed = catalogProvider(input.id);
  const row = await deps.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(modelProviders)
      .values({
        slug: input.id,
        name:
          input.name?.trim() || (input.kind === "catalog" ? (listed?.name ?? input.id) : input.id),
        kind: input.kind,
        api: input.kind === "custom" ? (input.api ?? "openai-completions") : null,
        baseUrl: input.baseUrl?.trim() || null,
        apiKey: input.apiKey ? deps.secrets.seal(input.apiKey) : null,
        keySetAt: input.apiKey ? now : null,
        apiKeyEnv: input.kind === "custom" ? input.apiKeyEnv?.trim() || null : null,
        position: (last?.position ?? 0) + 1,
        customModels: input.kind === "custom" || Boolean(input.models),
        createdAt: now,
      })
      .onConflictDoNothing({ target: modelProviders.slug })
      .returning();
    if (!created) return undefined;
    if (input.models) await replaceModels(tx, created.id, input.models);
    return created;
  });
  if (!row) return { ok: false, error: "provider_exists" };
  return { ok: true, row };
}

export interface ProviderPatch {
  name?: string;
  api?: ModelProtocol;
  baseUrl?: string | null;
  /** 新的 key；null 是删掉已保存的（退回环境变量）。 */
  apiKey?: string | null;
  apiKeyEnv?: string | null;
  enabled?: boolean;
  /** 整个替换模型列表（改成自己的列表）。 */
  models?: ModelSpec[];
  /** "恢复默认模型"：删掉自己的列表，重新跟着目录或者发布的列表。自定义接口不能。 */
  resetModels?: boolean;
}

export async function updateProvider(
  deps: ModelsDeps,
  slug: string,
  patch: ProviderPatch,
): Promise<{ ok: true; row: ProviderRow } | { ok: false; error: ProviderError; message?: string }> {
  const row = await providerRow(deps, slug);
  if (!row) return { ok: false, error: "provider_not_found" };
  if (patch.models) {
    if (row.kind === "custom" && patch.models.length === 0) {
      return { ok: false, error: "invalid_models", message: "请至少保留一个模型" };
    }
    const invalid = checkModels(patch.models);
    if (invalid) return { ok: false, error: "invalid_models", message: invalid };
  }
  if (patch.resetModels && row.kind === "custom") {
    return { ok: false, error: "invalid_models", message: "自定义接口没有默认的模型列表" };
  }
  const now = deps.clock.now();
  const updated = await deps.db.transaction(async (tx) => {
    const [next] = await tx
      .update(modelProviders)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() || row.slug } : {}),
        ...(patch.api !== undefined && row.kind === "custom" ? { api: patch.api } : {}),
        ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl?.trim() || null } : {}),
        ...(patch.apiKey !== undefined
          ? patch.apiKey === null
            ? { apiKey: null, keySetAt: null, keyRejectedAt: null }
            : { apiKey: deps.secrets.seal(patch.apiKey), keySetAt: now, keyRejectedAt: null }
          : {}),
        ...(patch.apiKeyEnv !== undefined && row.kind === "custom"
          ? { apiKeyEnv: patch.apiKeyEnv?.trim() || null }
          : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.models ? { customModels: true } : {}),
        ...(patch.resetModels ? { customModels: false } : {}),
      })
      .where(eq(modelProviders.id, row.id))
      .returning();
    if (patch.models) await replaceModels(tx, row.id, patch.models);
    if (patch.resetModels) await replaceModels(tx, row.id, []);
    return next;
  });
  return { ok: true, row: updated ?? row };
}

/** 用着这个提供方的模型、还没归档的会话有几个（删除前提示）。 */
export async function sessionsUsing(deps: Pick<AppDeps, "db">, slug: string): Promise<number> {
  const prefix = `${slug.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
  const legacy = slug === DEEPSEEK_PROVIDER ? sql`or ${sessions.model} not like '%/%'` : sql``;
  const [row] = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(ne(sessions.status, "archived"), sql`(${like(sessions.model, prefix)} ${legacy})`));
  return row?.count ?? 0;
}

/** 删掉一个提供方（连同它的模型列表和 key）。内置的 DeepSeek 不能删，只能停用。 */
export async function deleteProvider(
  deps: Pick<AppDeps, "db">,
  slug: string,
): Promise<{ ok: true } | { ok: false; error: ProviderError }> {
  const row = await providerRow(deps, slug);
  if (!row) return { ok: false, error: "provider_not_found" };
  if (row.kind === "deepseek") return { ok: false, error: "provider_builtin" };
  await deps.db.delete(modelProviders).where(eq(modelProviders.id, row.id));
  return { ok: true };
}

/** 调整提供方的先后：按给的顺序重新编号，没列出来的排在后面、保持原来的先后。 */
export async function reorderProviders(deps: Pick<AppDeps, "db">, order: string[]): Promise<void> {
  const rows = await providerRows(deps);
  const listed = order.filter((slug) => rows.some((r) => r.slug === slug));
  const rest = rows.map((r) => r.slug).filter((slug) => !listed.includes(slug));
  await deps.db.transaction(async (tx) => {
    for (const [position, slug] of [...listed, ...rest].entries()) {
      await tx.update(modelProviders).set({ position }).where(eq(modelProviders.slug, slug));
    }
  });
}

/** 目录里的提供方（"添加模型提供商 → 第三方模型提供商"）：已经加过的标出来。 */
export async function catalogList(deps: Pick<AppDeps, "db">) {
  const added = new Set(
    (
      await deps.db
        .select({ slug: modelProviders.slug })
        .from(modelProviders)
        .where(
          inArray(
            modelProviders.slug,
            CATALOG.providers.map((p) => p.id),
          ),
        )
    ).map((r) => r.slug),
  );
  return CATALOG.providers.map((p) => ({
    id: p.id,
    name: p.name,
    env: p.env,
    protocols: Object.keys(p.endpoints) as ModelProtocol[],
    baseUrl: Object.values(p.endpoints)[0] ?? null,
    models: p.models.length,
    added: added.has(p.id),
  }));
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
