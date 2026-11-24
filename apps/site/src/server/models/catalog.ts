import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEEPSEEK_PROVIDER,
  type ModelProtocol,
  modelRef,
  type ThinkingEffort,
} from "@seekcloud/protocol";
import type { ModelEntry, ModelInput } from "./types";

/**
 * 第三方提供方的目录：cli/model-catalog.ts 从 dsh 用的 @earendil-works/pi-ai（MIT）生成的快照。
 * 只收填一个 key 就能用的提供方（那个文件开头写着收哪些）。
 */
export interface CatalogProvider {
  id: string;
  name: string;
  /** 没填 key 时读的环境变量，按先后找第一个有值的。 */
  env: string[];
  /** 每种协议的接口地址（多数提供方只有一种）。 */
  endpoints: Partial<Record<ModelProtocol, string>>;
  models: Array<{
    id: string;
    name: string;
    api: ModelProtocol;
    input: ModelInput[];
    contextWindow: number | null;
    maxTokens: number | null;
    efforts: ThinkingEffort[];
    /** 各档位发给接口的参数值里和档位名不一样的（比如 off 发 "none"）。 */
    wire?: Partial<Record<ThinkingEffort, string>>;
    cost: [number, number] | null;
  }>;
}

export const CATALOG = JSON.parse(
  readFileSync(join(import.meta.dirname, "catalog.json"), "utf8"),
) as {
  source: { piAi: string; dsh: string };
  providers: CatalogProvider[];
};

export const catalogProvider = (id: string) => CATALOG.providers.find((p) => p.id === id);

/**
 * DeepSeek 官方的地址：Messages 走 Anthropic 格式的接口，发布的模型列表在域名根下的 /models。
 * 表里存的名字是空的，界面按语言写（中文"DeepSeek 官方"，#136：服务端不存现成的中文）；这里的 name 是
 * 发给沙箱里的 dsh 用的。
 */
export const DEEPSEEK = {
  slug: DEEPSEEK_PROVIDER,
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  env: "DEEPSEEK_API_KEY",
} as const;

/** DeepSeek 的模型都给这四档（dsh 的 DeepSeek 适配器）。 */
export const DEEPSEEK_EFFORTS: ThinkingEffort[] = ["off", "low", "high", "max"];
/** DeepSeek 官方的上下文窗口（dsh 的 OFFICIAL_CONTEXT_WINDOW）和默认的最大输出（dsh 的 DEFAULT_MAX_TOKENS）。 */
const DEEPSEEK_CONTEXT = 1_048_576;
export const DEEPSEEK_MAX_TOKENS = 256_000;

/**
 * DeepSeek 内置的两个模型（和 dsh 0.2.2 的内置目录一样）：设置卡片上显示它们；发布的列表取不到时也用它们。
 * 价钱是 pi-ai 目录里的，平台调用选"自动"时挑最省的。一句话说明是界面文案，在浏览器的文案目录里（#136）。
 */
export const DEEPSEEK_MODELS: ModelEntry[] = [
  {
    ref: modelRef(DEEPSEEK_PROVIDER, "deepseek-flash"),
    provider: DEEPSEEK_PROVIDER,
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    api: "anthropic-messages",
    contextWindow: DEEPSEEK_CONTEXT,
    maxTokens: DEEPSEEK_MAX_TOKENS,
    input: ["text", "image"],
    efforts: DEEPSEEK_EFFORTS,
    cost: [0.3, 1.2],
  },
  {
    ref: modelRef(DEEPSEEK_PROVIDER, "deepseek-v4-pro"),
    provider: DEEPSEEK_PROVIDER,
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    api: "anthropic-messages",
    contextWindow: DEEPSEEK_CONTEXT,
    maxTokens: DEEPSEEK_MAX_TOKENS,
    input: ["text"],
    efforts: DEEPSEEK_EFFORTS,
    cost: [1.32, 3.96],
  },
];
