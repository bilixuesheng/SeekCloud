import type { ModelProtocol } from "@seekcloud/protocol";

/**
 * 按协议读出用量（#113 的透明转发）。记的口径和 Anthropic 的一样：输入不含读缓存的部分、读缓存、写缓存、输出分开记。
 * OpenAI、Gemini 报的输入里含着读缓存的部分，减掉；Gemini 的思考 token 算进输出。
 */

export interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_TOKENS: Tokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Anthropic 的 usage：和已有的取大的（message_delta 里的输出数是累计的）。 */
export function mergeAnthropicUsage(tokens: Tokens, usage: unknown): Tokens {
  const u = fieldsOf(usage);
  if (!u) return tokens;
  return {
    inputTokens: Math.max(tokens.inputTokens, n(u.input_tokens)),
    outputTokens: Math.max(tokens.outputTokens, n(u.output_tokens)),
    cacheReadTokens: Math.max(tokens.cacheReadTokens, n(u.cache_read_input_tokens)),
    cacheWriteTokens: Math.max(tokens.cacheWriteTokens, n(u.cache_creation_input_tokens)),
  };
}

/** OpenAI Chat Completions 的 usage（prompt_tokens 里含着 cached_tokens）。 */
function completionsUsage(usage: unknown): Tokens | undefined {
  const u = fieldsOf(usage);
  if (!u) return undefined;
  const cached = n(fieldsOf(u.prompt_tokens_details)?.cached_tokens);
  return {
    inputTokens: Math.max(0, n(u.prompt_tokens) - cached),
    outputTokens: n(u.completion_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** OpenAI Responses 的 usage（input_tokens 里含着 cached_tokens）。 */
function responsesUsage(usage: unknown): Tokens | undefined {
  const u = fieldsOf(usage);
  if (!u) return undefined;
  const cached = n(fieldsOf(u.input_tokens_details)?.cached_tokens);
  return {
    inputTokens: Math.max(0, n(u.input_tokens) - cached),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** Gemini 的 usageMetadata（promptTokenCount 里含着 cachedContentTokenCount；思考的 token 单独报，算进输出）。 */
function geminiUsage(usage: unknown): Tokens | undefined {
  const u = fieldsOf(usage);
  if (!u) return undefined;
  const cached = n(u.cachedContentTokenCount);
  return {
    inputTokens: Math.max(0, n(u.promptTokenCount) - cached),
    outputTokens: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** 非流式的响应体里的用量。 */
export function usageOfBody(protocol: ModelProtocol, body: unknown): Tokens {
  const b = fieldsOf(body);
  if (!b) return ZERO_TOKENS;
  switch (protocol) {
    case "anthropic-messages":
      return mergeAnthropicUsage(ZERO_TOKENS, b.usage);
    case "openai-completions":
      return completionsUsage(b.usage) ?? ZERO_TOKENS;
    case "openai-responses":
      return responsesUsage(b.usage) ?? ZERO_TOKENS;
    case "google-generative-ai":
      return geminiUsage(b.usageMetadata) ?? ZERO_TOKENS;
  }
}

/**
 * 流式响应的用量：一个事件一个事件地喂进来（event 是 SSE 的 event 名，没有时为空）。
 * - Chat Completions：带 usage 的那一块（网关补了 stream_options.include_usage，在最后）；
 * - Responses：response.completed（中途断开时 response.in_progress 里没有用量）；
 * - Anthropic：message_start、message_delta；
 * - Gemini：每一块都带着到目前为止的 usageMetadata，取最后一块的。
 */
export class UsageMeter {
  tokens: Tokens = ZERO_TOKENS;
  /** 看到了正常结束的标记（Chat Completions 的 [DONE] 或 finish_reason、Responses 的 completed、Anthropic 的 message_stop）。 */
  finished = false;

  constructor(readonly protocol: ModelProtocol) {}

  feed(event: string | undefined, dataText: string): void {
    if (this.protocol === "openai-completions" && dataText.trim() === "[DONE]") {
      this.finished = true;
      return;
    }
    let data: Fields | undefined;
    try {
      data = fieldsOf(JSON.parse(dataText));
    } catch {
      return;
    }
    if (!data) return;
    const type = event ?? (typeof data.type === "string" ? data.type : undefined);
    switch (this.protocol) {
      case "openai-completions": {
        const usage = completionsUsage(data.usage);
        if (usage) this.tokens = usage;
        const choices = Array.isArray(data.choices) ? data.choices : [];
        if (choices.some((c) => fieldsOf(c)?.finish_reason)) this.finished = true;
        return;
      }
      case "openai-responses": {
        if (type === "response.completed" || type === "response.incomplete") {
          const usage = responsesUsage(fieldsOf(data.response)?.usage);
          if (usage) this.tokens = usage;
          this.finished = type === "response.completed";
        }
        return;
      }
      case "anthropic-messages": {
        if (type === "message_start") {
          this.tokens = mergeAnthropicUsage(this.tokens, fieldsOf(data.message)?.usage);
        }
        if (type === "message_delta") this.tokens = mergeAnthropicUsage(this.tokens, data.usage);
        if (type === "message_stop") this.finished = true;
        return;
      }
      case "google-generative-ai": {
        const usage = geminiUsage(data.usageMetadata);
        if (usage) this.tokens = usage;
        const candidates = Array.isArray(data.candidates) ? data.candidates : [];
        if (candidates.some((c) => fieldsOf(c)?.finishReason)) this.finished = true;
        return;
      }
    }
  }
}
