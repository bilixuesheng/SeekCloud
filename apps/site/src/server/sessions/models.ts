import { THINKING_EFFORTS, type ThinkingEffort } from "@seekcloud/protocol";

export interface ModelInfo {
  id: string;
  name: string;
  /** 一句话说明，给用户挑模型时看。 */
  description: string;
  /** 能不能看图（发图片要用）。 */
  vision: boolean;
  efforts: readonly ThinkingEffort[];
}

/**
 * 可选的模型。管理端维护模型列表之前先写在这里。
 * 思考强度对应 DeepSeek 的 thinking 开关和 effort：关闭 = 不思考，其余是 low / high / max。
 */
export const MODELS: readonly ModelInfo[] = [
  {
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    description: "速度快、用量省，适合日常改动",
    vision: false,
    efforts: THINKING_EFFORTS,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "更强，适合复杂的任务",
    vision: false,
    efforts: THINKING_EFFORTS,
  },
];

export const DEFAULT_MODEL = "deepseek-flash";
export const DEFAULT_EFFORT: ThinkingEffort = "high";

export const findModel = (id: string) => MODELS.find((m) => m.id === id);
