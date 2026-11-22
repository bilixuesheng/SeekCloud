import type { ModelProtocol, ThinkingEffort } from "@seekcloud/protocol";

/** 设置的"模型"用到的接口和形状（server/routes/model.ts）。 */
export const MODEL_PROVIDERS = "/api/settings/model-providers";
export const CATALOG = "/api/settings/model-providers/catalog";

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
}

/** 设置接口回来的一个模型：没填的项是用上的默认值。 */
export interface ModelSpecView extends ModelSpec {
  name: string;
  contextWindow: number;
  maxTokens: number;
  efforts: ThinkingEffort[];
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
    contextWindow: view.contextWindow,
    maxTokens: view.maxTokens,
    input: view.input,
    reasoningEfforts: view.reasoningEfforts ?? null,
    compat: view.compat ?? null,
  };
}
