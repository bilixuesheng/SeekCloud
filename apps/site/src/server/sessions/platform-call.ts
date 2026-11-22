import type { ModelGateway } from "../gateway/gateway";
import type { ModelCatalog } from "../models/providers";
import type { ModelPurpose } from "../ports";

/**
 * 平台自己发起的模型调用（判断是否在等输入 #140、置顶消息的短标题）共用的写法：
 * 经模型网关的内部入口（ModelGateway.complete），照常过准入、记用量；不开思考，输出很短；
 * 用哪个模型看设置的"平台调用的模型"（ModelCatalog.platformModel）。调用失败（没有能用的模型、
 * 被用量上限拒绝、上游出错、超时）一律返回 undefined，不抛错，由调用方退回规则。
 */

export type PlatformGateway = Pick<ModelGateway, "complete">;
export type PlatformDeps = { models: Pick<ModelCatalog, "platformModel"> };

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
  const model = await deps.models.platformModel(call.userId).catch(() => undefined);
  // 现在只会用 Anthropic Messages 格式问；别的协议的平台调用跟着透明转发做（#113 的第二步）
  if (model?.api !== "anthropic-messages") return undefined;
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
        model: model.ref,
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
