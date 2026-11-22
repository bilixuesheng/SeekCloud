import type { ModelProtocol, ThinkingEffort } from "@seekcloud/protocol";

/** 提供方的种类：内置的 DeepSeek 官方、目录里的第三方提供方、自定义接口（#113）。 */
export const PROVIDER_KINDS = ["deepseek", "catalog", "custom"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** 模型接受的输入（dsh 的 input）。 */
export const MODEL_INPUTS = ["text", "image"] as const;
export type ModelInput = (typeof MODEL_INPUTS)[number];

/** 推理等级：档位到发给接口的参数值（dsh 的 reasoningEfforts）。只有 off 可以是 null（不传参数）。 */
export type ReasoningEfforts = Partial<Record<ThinkingEffort, string | null>>;

/** 自定义模型没写上下文窗口、最大输出时的默认值（dsh-llm-pi-ai 的 DEFAULT_CONTEXT_WINDOW、DEFAULT_MAX_TOKENS）。 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_MAX_TOKENS = 128_000;

/**
 * 一个模型，所有来源（DeepSeek 内置和发布的列表、目录、自己的列表）都整理成这个样子。
 * ref 是"提供方/模型"，会话和设置里记它。
 */
export interface ModelEntry {
  ref: string;
  provider: string;
  /** 发给接口的模型 ID。 */
  id: string;
  name: string;
  /** 一句话说明（DeepSeek 内置的两个有）。 */
  description?: string;
  /** 这个模型用哪种协议。 */
  api: ModelProtocol;
  contextWindow: number;
  maxTokens: number;
  input: ModelInput[];
  /** 模型选择器里能选的思考强度，从低到高；只有 off（或者空）时不显示思考强度。 */
  efforts: ThinkingEffort[];
  /** 每百万 token 的输入、输出价钱（美元，目录里有才有）。平台调用选"自动"时挑最省的。 */
  cost: [number, number] | null;
}

/** 请求兼容性开关（dsh 的 compat），开关名到值。 */
export type ModelCompat = Record<string, string | number | boolean>;

/** 一个模型在自己的列表里怎么写（provider_models 的一行，也是设置接口收发的形状）。 */
export interface ModelSpec {
  id: string;
  name?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  input: ModelInput[];
  reasoningEfforts?: ReasoningEfforts | null;
  compat?: ModelCompat | null;
}
