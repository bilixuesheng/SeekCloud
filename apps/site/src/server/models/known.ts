import type { ModelProtocol, ThinkingEffort } from "@seekcloud/protocol";
import { CATALOG, type CatalogProvider } from "./catalog";
import type { ModelInput } from "./types";

/**
 * 认得出来的模型：dsh 内置目录（catalog.json）里的模型。自定义接口添加模型、"获取可用模型"时按模型 ID 找它，
 * 把上下文窗口、最大输出、能不能看图、思考档位和价格先填好，管理员不用自己去查。
 * 同一个模型常常出现在好几个提供方下面（官方和 OpenRouter 这类转售的），取官方的那份。
 */
export interface KnownModel {
  id: string;
  name: string;
  /** 资料来自目录里的哪个提供方。 */
  provider: string;
  providerName: string;
  api: ModelProtocol;
  contextWindow: number | null;
  maxTokens: number | null;
  input: ModelInput[];
  /** 能选的思考档位，从低到高；只有 off 的是不思考的模型。 */
  efforts: ThinkingEffort[];
  /** 各档位发给接口的参数值里和档位名不一样的。 */
  wire?: Partial<Record<ThinkingEffort, string>>;
  /** 每百万 token 的输入、输出价格（美元）。 */
  cost: [number, number] | null;
}

/** 模型的出处，越靠前越可信：模型厂商自己的在前，转售、聚合的在后。 */
const FIRST_PARTY = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "moonshotai",
  "moonshotai-cn",
  "kimi-coding",
  "zai",
  "zai-coding-cn",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "meta",
  "ant-ling",
];
const rank = (provider: string) => {
  const i = FIRST_PARTY.indexOf(provider);
  return i < 0 ? FIRST_PARTY.length : i;
};

/**
 * 比较用的模型 ID：小写，去掉路径前缀（openrouter 的 anthropic/…、fireworks 的 accounts/…/models/…）、
 * 冒号后缀（:free、:thinking），点和下划线当成连字符（claude-sonnet-4.5 和 claude-sonnet-4-5 是同一个）。
 */
export function normalizeModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/:.*$/, "")
    .replace(/[._\s]+/g, "-");
}

/**
 * 目录里的一个模型整理成 KnownModel。跨提供方认模型时，价格是 0 的当作不知道：
 * 那是包月套餐（qwen-token-plan 这类）的记法，不是这个模型的价钱。
 */
const known = (
  provider: CatalogProvider,
  m: CatalogProvider["models"][number],
  keepZeroCost = false,
): KnownModel => ({
  id: m.id,
  name: m.name,
  provider: provider.id,
  providerName: provider.name,
  api: m.api,
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
  input: m.input,
  efforts: m.efforts,
  ...(m.wire ? { wire: m.wire } : {}),
  cost: m.cost && (keepZeroCost || m.cost[0] > 0 || m.cost[1] > 0) ? m.cost : null,
});

/** 目录里所有的模型，同一个模型只留最可信的那份（按比较用的 ID 去重）。 */
let deduped: Map<string, KnownModel> | undefined;
function everyModel(): Map<string, KnownModel> {
  if (deduped) return deduped;
  const best = new Map<string, KnownModel>();
  for (const provider of CATALOG.providers) {
    for (const m of provider.models) {
      const key = normalizeModelId(m.id);
      const seen = best.get(key);
      const candidate = known(provider, m);
      // 更可信的出处优先；一样可信时，资料更全的（有上下文窗口、有价格）优先
      const fullness = (k: KnownModel) => (k.contextWindow ? 2 : 0) + (k.cost ? 1 : 0);
      const better =
        !seen ||
        rank(provider.id) < rank(seen.provider) ||
        (rank(provider.id) === rank(seen.provider) && fullness(candidate) > fullness(seen));
      if (better) best.set(key, candidate);
    }
  }
  deduped = best;
  return best;
}

/** 按模型 ID 认一个模型；认不出来时为空。 */
export function recognizeModel(id: string): KnownModel | undefined {
  return everyModel().get(normalizeModelId(id));
}

/**
 * 搜目录里的模型（添加模型时的候选）：provider 给了只搜那个提供方的（目录里的提供方添加模型），
 * 没给就搜全部、去重。query 按空格拆开，每段都要出现在 ID 或名称里；ID 完全一样的排最前，再是 ID 开头一样的。
 */
export function searchKnownModels(
  query: string,
  options: { provider?: string; limit?: number } = {},
): KnownModel[] {
  const limit = options.limit ?? 30;
  const pool: KnownModel[] = options.provider
    ? (() => {
        const provider = CATALOG.providers.find((p) => p.id === options.provider);
        // 目录里的提供方自己的模型：价格照目录（套餐的 0 也是它的价钱）
        return provider ? provider.models.map((m) => known(provider, m, true)) : [];
      })()
    : [...everyModel().values()];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = normalizeModelId(query);
  const scored = pool.flatMap((m) => {
    const haystack = `${m.id.toLowerCase()} ${normalizeModelId(m.id)} ${m.name.toLowerCase()}`;
    if (!words.every((w) => haystack.includes(w) || haystack.includes(normalizeModelId(w)))) {
      return [];
    }
    const id = normalizeModelId(m.id);
    const score = !wanted ? 2 : id === wanted ? 0 : id.startsWith(wanted) ? 1 : 2;
    return [{ m, score }];
  });
  // 没有搜索词时保持目录的顺序（提供方自己的排法）；有搜索词时按匹配程度，再按出处
  if (words.length > 0) {
    scored.sort((a, b) => a.score - b.score || rank(a.m.provider) - rank(b.m.provider));
  }
  return scored.slice(0, limit).map((s) => s.m);
}
