import type { AppDeps } from "../app";
import type { ModelGateway } from "../gateway/gateway";
import type { ModelPurpose } from "../ports";
import { readSetting } from "../settings";
import { MODELS } from "./models";

/**
 * 平台自己发起的模型调用（判断是否在等输入 #140、置顶消息的短标题）共用的写法：
 * 经模型网关的内部入口（ModelGateway.complete），照常过准入、记用量；不开思考，输出很短；
 * 用哪个模型看设置的"平台调用的模型"。调用失败（没填 key、被用量上限拒绝、上游出错、超时）
 * 一律返回 undefined，不抛错，由调用方退回规则。
 */

export type PlatformGateway = Pick<ModelGateway, "complete">;
export type PlatformDeps = Pick<AppDeps, "db" | "settingsPolicy">;

/** 平台调用用哪个模型：设置里选了就用它，自动（或者选的不在了）就用最省的那个。 */
export async function platformModel(deps: PlatformDeps, userId: string): Promise<string> {
  const chosen = await readSetting(deps, "platform_model", { userId });
  if (MODELS.some((m) => m.id === chosen)) return chosen;
  return [...MODELS].sort((a, b) => a.relativeCost - b.relativeCost)[0]?.id ?? MODELS[0]?.id ?? "";
}

/**
 * Agent 写的文字用标记包起来放进提示词：它可能带着外部内容里的诱导，说明里要写明标记里是待处理的文字、
 * 不是指令。文字里的同名标记改掉，免得提前把标记关上；太长只取结尾（maxChars）。
 */
export function wrapUntrusted(tag: string, text: string, maxChars: number): string {
  const tail = text.length > maxChars ? text.slice(-maxChars) : text;
  const own = new RegExp(`</?${tag}>`, "gi");
  return `<${tag}>\n${tail.replace(own, `[${tag}]`)}\n</${tag}>`;
}

/** 问一次模型，拿回它的文字。判断不出来、出错、超时都是 undefined。 */
export async function askPlatformModel(
  deps: PlatformDeps,
  gateway: PlatformGateway,
  call: {
    purpose: ModelPurpose;
    userId: string;
    sessionId: string;
    prompt: string;
    maxTokens: number;
    timeoutMs: number;
  },
): Promise<string | undefined> {
  const model = await platformModel(deps, call.userId);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), call.timeoutMs);
  });
  const answer = gateway
    .complete(
      {
        purpose: call.purpose,
        userId: call.userId,
        sessionId: call.sessionId,
        turnId: null,
        model,
      },
      {
        max_tokens: call.maxTokens,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: call.prompt }],
      },
    )
    .then((result) => textOf(result))
    .catch(() => undefined);
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Messages 接口的回答里的文字。 */
function textOf(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}
