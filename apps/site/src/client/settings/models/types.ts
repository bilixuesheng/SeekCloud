import type { ModelProtocol, ThinkingEffort } from "@seekcloud/protocol";

/** 设置的"模型"用到的接口和形状（server/routes/model.ts）。 */
export const MODEL_PROVIDERS = "/api/settings/model-providers";
export const CATALOG = "/api/settings/model-providers/catalog";
export const KNOWN_MODELS = "/api/settings/model-providers/known-models";

export type ModelInput = "text" | "image";
export type ReasoningEfforts = Partial<Record<ThinkingEffort, string | null>>;

/** 一个模型在列表里怎么写（保存时发给接口的形状）。 */
export interface ModelSpec {
  id: string;
  name?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  input: ModelInput[];
  reasoningEfforts?: ReasoningEfforts | null;
  compat?: Record<string, string | number | boolean> | null;
  /** 管理员填的价格：每百万 token 的输入、输出（美元）。 */
  cost?: [number, number] | null;
}

/** 设置接口回来的一个模型：没填的项是用上的默认值。 */
export interface ModelSpecView extends ModelSpec {
  name: string;
  contextWindow: number;
  maxTokens: number;
  efforts: ThinkingEffort[];
  cost: [number, number] | null;
  /** 目录（或 DeepSeek 内置）里的价格。 */
  listedCost: [number, number] | null;
  /** 上下文窗口没填、目录里也没有，contextWindow 是默认值。 */
  unsized: boolean;
}

/** dsh 内置目录里认得出来的模型（添加模型的候选、获取可用模型时认出来的）。 */
export interface KnownModel {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  api: ModelProtocol;
  contextWindow: number | null;
  maxTokens: number | null;
  input: ModelInput[];
  efforts: ThinkingEffort[];
  wire?: Partial<Record<ThinkingEffort, string>>;
  cost: [number, number] | null;
}

/** 获取可用模型时端点列出的一个模型。 */
export interface ProbedModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  known?: KnownModel;
}

export interface ProviderView {
  id: string;
  name: string;
  kind: "deepseek" | "catalog" | "custom";
  api: ModelProtocol | null;
  protocols: ModelProtocol[];
  baseUrl: string | null;
  defaultBaseUrl: string | null;
  enabled: boolean;
  credential: {
    masked: string | null;
    env: string[];
    envDetected: string | null;
    apiKeyEnv: string | null;
  };
  keySetAt: string | null;
  keyRejectedAt: string | null;
  customModels: boolean;
  models: ModelSpecView[];
}

export interface CatalogEntry {
  id: string;
  name: string;
  env: string[];
  protocols: ModelProtocol[];
  baseUrl: string | null;
  models: number;
  added: boolean;
  envDetected: string | null;
}

export const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Gemini API",
};

/** 自定义模型没写时用的默认值（和主站、dsh 的一样）。 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_MAX_TOKENS = 128_000;

/** key 的草稿：不动（用已保存的）、换成新的、删掉（保存后退回环境变量）。 */
export type KeyDraft = { kind: "keep" } | { kind: "replace"; value: string } | { kind: "delete" };

/** 保存时发给接口的 apiKey：不动是 undefined，删掉是 null。 */
export const keyPatch = (draft: KeyDraft): string | null | undefined =>
  draft.kind === "keep" ? undefined : draft.kind === "delete" ? null : draft.value.trim() || null;

/** 列表里的一个模型 → 保存时的形状（默认值不写回去，留给主站算）。 */
export function specOf(view: ModelSpecView): ModelSpec {
  return {
    id: view.id,
    name: view.name && view.name !== view.id ? view.name : null,
    // 没填的上下文窗口还是没填（不把默认值当成填了的写回去）
    contextWindow: view.unsized ? null : view.contextWindow,
    maxTokens: view.maxTokens,
    input: view.input,
    reasoningEfforts: view.reasoningEfforts ?? null,
    compat: view.compat ?? null,
    cost: view.cost ?? null,
  };
}
