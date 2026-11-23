import { createHash } from "node:crypto";
import { DEEPSEEK_PROVIDER, modelRef } from "@seekcloud/protocol";
import { CATALOG, DEEPSEEK_EFFORTS, DEEPSEEK_MAX_TOKENS, DEEPSEEK_MODELS } from "./catalog";
import type { ModelEntry, ModelInput } from "./types";

/**
 * DeepSeek 发布的模型列表（GET https://api.deepseek.com/models），照 dsh 的 dsh-llm-deepseek-api-key：
 * 填了 key、没自定义模型列表时，DeepSeek 的模型跟着它走。第一次要用时去取（最多等 timeoutMs），之后每过
 * maxAgeMs 再用到时在后台刷新；取不到、列表为空时留着上一份，一份都没有时用内置的两个。
 * 缓存只在内存里，按 key 的哈希分开（换了 key 用它自己的列表）。
 */

export interface ListingOptions {
  fetch: typeof fetch;
  now: () => number;
  /** 单次请求、第一次等列表的上限。dsh 默认 5 秒。 */
  timeoutMs?: number;
  /** 多久刷新一次。dsh 默认十分钟。 */
  maxAgeMs?: number;
  userAgent: string;
}

/** dsh 在列表里认的产品名（client_requirements、client_metadata 下面的键）。 */
const PRODUCT = "deepseek-harness";
export const LISTING_URL = "https://api.deepseek.com/models";

interface Cached {
  models: ModelEntry[];
  /** 上一次去取的时间（取到没取到都算）；还没取过时为空。 */
  loadedAt?: number;
  loading?: Promise<void>;
}

export class DeepSeekListing {
  readonly #options: ListingOptions;
  readonly #cache = new Map<string, Cached>();

  constructor(options: ListingOptions) {
    this.#options = options;
  }

  /** 这把 key 能用的 DeepSeek 模型：发布的列表，或者内置的两个。 */
  async models(apiKey: string): Promise<ModelEntry[]> {
    const id = createHash("sha256").update(apiKey).digest("hex");
    const maxAge = this.#options.maxAgeMs ?? 600_000;
    let cached = this.#cache.get(id);
    if (!cached) {
      cached = { models: [] };
      this.#cache.set(id, cached);
    }
    const stale = cached.loadedAt === undefined || this.#options.now() - cached.loadedAt >= maxAge;
    if (stale && !cached.loading) {
      const entry = cached;
      entry.loading = this.#load(apiKey, entry).finally(() => {
        entry.loading = undefined;
      });
    }
    // 第一次：等这一次取完（有上限）；以后：先用缓存，刷新在后台做
    if (cached.models.length === 0 && cached.loading) await cached.loading;
    return cached.models.length > 0 ? cached.models : DEEPSEEK_MODELS;
  }

  async #load(apiKey: string, entry: Cached): Promise<void> {
    const timeout = this.#options.timeoutMs ?? 5_000;
    try {
      const response = await this.#options.fetch(LISTING_URL, {
        headers: { "x-api-key": apiKey, "user-agent": this.#options.userAgent },
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const models = decodeListing(await response.json(), CATALOG.source.dsh);
      if (models.length === 0) throw new Error("列表为空");
      entry.models = models;
    } catch (error) {
      console.warn(`[deepseek-listing] 取不到 DeepSeek 发布的模型列表：${String(error)}`);
    } finally {
      // 失败了也按间隔重试，不在每次用到时都去取
      entry.loadedAt = this.#options.now();
    }
  }
}

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const capacity = (value: unknown): number | undefined | false =>
  value === undefined || value === null
    ? undefined
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : false;

/**
 * 读列表（dsh 的 listing.ts 和账号路由的规则）：
 * - 要声明 api_capabilities.anthropic_messages、输出有文字；输入只认 text、image；
 * - client_requirements["deepseek-harness"].min_version 不高于沙箱里 dsh 的版本才给；没有这个声明的，只有内置目录认识它才给；
 * - 用列表里的名称、context_window、输入类型盖过内置的；max_output_tokens 限住默认的最大输出。
 */
export function decodeListing(body: unknown, dshVersion: string): ModelEntry[] {
  const rows = fieldsOf(body)?.data;
  if (!Array.isArray(rows)) return [];
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const entry = fieldsOf(row);
    const id = entry?.id;
    if (!entry || typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const builtin = DEEPSEEK_MODELS.find((m) => m.id === id);
    if (!allowed(entry, Boolean(builtin), dshVersion)) continue;
    if (!fieldsOf(fieldsOf(entry.api_capabilities)?.anthropic_messages)) continue;
    const outputs = entry.output_modalities === undefined ? ["text"] : entry.output_modalities;
    if (!Array.isArray(outputs) || !outputs.includes("text")) continue;
    const listedInput = entry.input_modalities === undefined ? ["text"] : entry.input_modalities;
    if (!Array.isArray(listedInput)) continue;
    const input = (["text", "image"] as ModelInput[]).filter((m) => listedInput.includes(m));
    if (input.length === 0) continue;
    const contextWindow = capacity(entry.context_window);
    const maxOutput = capacity(entry.max_output_tokens);
    if (contextWindow === false || maxOutput === false) continue;
    const name =
      typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
    out.push({
      ref: modelRef(DEEPSEEK_PROVIDER, id),
      provider: DEEPSEEK_PROVIDER,
      id,
      name: name ?? builtin?.name ?? id,
      api: "anthropic-messages",
      contextWindow:
        contextWindow ?? builtin?.contextWindow ?? DEEPSEEK_MODELS[0]?.contextWindow ?? 0,
      maxTokens: Math.min(builtin?.maxTokens ?? DEEPSEEK_MAX_TOKENS, maxOutput ?? Infinity),
      input,
      efforts: DEEPSEEK_EFFORTS,
      cost: builtin?.cost ?? null,
    });
  }
  return out;
}

function allowed(entry: Fields, known: boolean, dshVersion: string): boolean {
  if (entry.client_requirements === undefined) return known;
  const requirements = fieldsOf(entry.client_requirements);
  if (!requirements) return false;
  const declared = requirements[PRODUCT];
  if (declared === undefined) return known;
  const own = fieldsOf(declared);
  if (!own) return false;
  if (own.min_version === undefined) return known;
  if (typeof own.min_version !== "string" || own.min_version.length === 0) return false;
  const order = compareVersions(dshVersion, own.min_version);
  return order !== undefined && order >= 0;
}

/** semver 的先后（预发布号低于同号的正式版）。读不懂时为 undefined。 */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    if (!m) return undefined;
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split(".") ?? [] };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] as number) - (y.core[i] as number);
    if (d !== 0) return Math.sign(d);
  }
  // 正式版高于同号的预发布版
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) return Math.sign(d);
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}
