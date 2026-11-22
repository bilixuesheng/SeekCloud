import { type ModelProtocol, THINKING_EFFORTS, type ThinkingEffort } from "@seekcloud/protocol";
import type { ReasoningEfforts } from "./types";

/**
 * 自定义接口的模型怎么声明思考（2026-11-22 用户说"不是每个模型思考档位都一样、参数都一样"）。
 * 档位选的是"模型选择器里能选哪几档"，参数值是"这一档发给接口的值"，两件事；而参数值是什么意思，看协议
 * （照 dsh 用的 pi-ai 的实际行为）：
 * - OpenAI Chat Completions：作为 reasoning_effort 发送；
 * - OpenAI Responses：作为 reasoning.effort 发送；
 * - Anthropic Messages：默认按思考预算发送（极低 1K、低 2K、中 8K、高 16K token，很高、最高按高算），参数值不用；
 *   打开"自适应思考"后作为 effort 发送（低、中、高、很高、最高）；
 * - Gemini：只有极低、低、中、高四档，按档位名发送，关不掉思考。
 */

/** Anthropic 的自适应思考开关（dsh 的 compat.forceAdaptiveThinking）。 */
export const ADAPTIVE = "forceAdaptiveThinking";

export interface ProtocolRules {
  /** 能选的档位，从低到高。 */
  levels: readonly ThinkingEffort[];
  /** 参数值能不能改（不能改的按档位名发送，或者不发）。 */
  editableValues: boolean;
  /** 发给接口的字段，说明里用。 */
  field?: string;
}

export function protocolRules(protocol: ModelProtocol, adaptive = false): ProtocolRules {
  switch (protocol) {
    case "openai-completions":
      return { levels: THINKING_EFFORTS, editableValues: true, field: "reasoning_effort" };
    case "openai-responses":
      return { levels: THINKING_EFFORTS, editableValues: true, field: "reasoning.effort" };
    case "anthropic-messages":
      return adaptive
        ? {
            levels: ["off", "low", "medium", "high", "xhigh", "max"],
            editableValues: true,
            field: "effort",
          }
        : { levels: ["off", "minimal", "low", "medium", "high"], editableValues: false };
    case "google-generative-ai":
      return { levels: ["minimal", "low", "medium", "high"], editableValues: false };
  }
}

/** Anthropic 按预算思考时每一档的预算（pi-ai 的 DEFAULT_THINKING_BUDGETS）。 */
export const ANTHROPIC_BUDGETS: Partial<Record<ThinkingEffort, number>> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

/** 一档的默认参数值：关闭不发，别的发档位名。 */
export const defaultValue = (level: ThinkingEffort): string | null =>
  level === "off" ? null : level;

/** 打开思考时默认选哪几档：关闭加上常见的低、中、高（协议没有的去掉）。 */
export function defaultLevels(protocol: ModelProtocol, adaptive = false): ReasoningEfforts {
  const { levels } = protocolRules(protocol, adaptive);
  const wanted: ThinkingEffort[] = ["off", "low", "medium", "high"];
  return Object.fromEntries(
    levels.filter((l) => wanted.includes(l)).map((l) => [l, defaultValue(l)]),
  );
}

/**
 * 换协议（或者开关自适应思考）以后，把已有的声明改成适用于新协议的：新协议没有的档位去掉，
 * 参数值不能改的协议改回档位名；去掉以后一档都不剩（或者只剩关闭）时换成新协议的默认档位。
 */
export function fitLevels(
  efforts: ReasoningEfforts | null | undefined,
  protocol: ModelProtocol,
  adaptive = false,
): ReasoningEfforts | null {
  if (!efforts) return null;
  const rules = protocolRules(protocol, adaptive);
  const kept: ReasoningEfforts = Object.fromEntries(
    THINKING_EFFORTS.filter((l) => l in efforts && rules.levels.includes(l)).map((l) => [
      l,
      rules.editableValues ? (efforts[l] ?? defaultValue(l)) : defaultValue(l),
    ]),
  );
  return Object.keys(kept).some((l) => l !== "off") ? kept : defaultLevels(protocol, adaptive);
}

/**
 * 认得出来的模型（dsh 内置目录里的）换成自定义接口上的声明：目录说不思考的为空；
 * 按目录的档位和参数值（比如关闭发 none），再适配这个接口的协议。
 */
export function levelsFromKnown(
  known: { efforts: ThinkingEffort[]; wire?: Partial<Record<ThinkingEffort, string>> },
  protocol: ModelProtocol,
): ReasoningEfforts | null {
  if (!known.efforts.some((l) => l !== "off")) return null;
  const declared: ReasoningEfforts = Object.fromEntries(
    known.efforts.map((l) => [l, known.wire?.[l] ?? defaultValue(l)]),
  );
  return fitLevels(declared, protocol);
}

/** 档位里有没有改过的参数值（和档位名不一样的）：有的话"参数值"默认展开。 */
export const hasCustomValues = (efforts: ReasoningEfforts | null | undefined) =>
  Object.entries(efforts ?? {}).some(
    ([level, value]) => value !== defaultValue(level as ThinkingEffort),
  );
