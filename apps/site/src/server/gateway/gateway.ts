import { randomBytes } from "node:crypto";
import type { ErrorCode } from "@seekcloud/protocol";
import type { AppDeps } from "../app";
import { upstreamErrors } from "../db/schema";
import type { ModelCall, ModelUsage, ProviderTarget } from "../ports";
import { markProviderKeyRejected } from "./trunk";

/** 上游响应头之前最多等这么久（流开始以后不限时，长的推理可以跑很久）。 */
const HEADERS_TIMEOUT_MS = 5 * 60_000;
/** 上游的报错最多存这么长。 */
const MAX_ERROR_BODY = 16 * 1024;
/** 给沙箱的响应只转发这几个上游响应头（ADR 0007）。 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after"];

type GatewayDeps = Pick<AppDeps, "db" | "clock" | "modelAdmission" | "providerRouting"> & {
  /** 发给上游用的 fetch，测试里换成假的提供方。 */
  modelFetch?: typeof fetch;
};

/** 给沙箱、给平台调用方看的一次出错：我们自己写的说明、状态码和参考号，不带上游的任何文字。 */
export interface GatewayFailure {
  code: ErrorCode;
  status: number;
  /** 上游出错时才有；网关自己拒绝（没 key、不放行）时没有。 */
  ref?: string;
  message: string;
  retryAfter?: string;
}

export class GatewayError extends Error {
  constructor(readonly failure: GatewayFailure) {
    super(failure.message);
  }
}

const DESCRIPTIONS: Record<ErrorCode, string> = {
  model_unavailable: "模型服务暂时不可用",
  model_rate_limited: "模型服务限流",
  model_rejected: "模型服务拒绝了请求",
  context_too_long: "对话超出模型的上下文长度",
  timeout: "等待模型服务超时",
  sandbox_unavailable: "无法创建沙箱",
  repo_clone_failed: "克隆仓库失败",
  internal: "模型网关出错",
};

/** 上游的状态码（和响应体）归到哪一类。只用来分类，响应体本身不往下传。 */
export function classify(status: number | null, body: string): ErrorCode {
  if (status === null) return "model_unavailable";
  if (status === 429) return "model_rate_limited";
  if (status >= 500) return "model_unavailable";
  if (status === 400 && /context|too long|maximum.*tokens|prompt is too long/i.test(body)) {
    return "context_too_long";
  }
  return "model_rejected";
}

/** Anthropic 的错误类型，沙箱里的 dsh 按它决定要不要重试。 */
function anthropicErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529 || status === 503) return "overloaded_error";
  return "api_error";
}

/** Anthropic 格式的错误响应。只有我们自己写的说明。 */
export function errorResponse(failure: GatewayFailure): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (failure.retryAfter) headers.set("retry-after", failure.retryAfter);
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: anthropicErrorType(failure.status), message: failure.message },
    }),
    { status: failure.status, headers },
  );
}

const REF_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
/** 参考号：我们自己随机生成的，不用上游的请求编号。 */
export function newRef(): string {
  return [...randomBytes(8)].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
}

/** 我们自己的消息 ID：不同平台的编号格式不一样，从编号能看出走的是哪家（ADR 0007）。 */
function newMessageId(): string {
  return `msg_${randomBytes(18).toString("base64url").replace(/[-_]/g, "x")}`;
}

interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const ZERO: Tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 从 Anthropic 的 usage 里取数，和已有的取大的（message_delta 里的输出数是累计的）。 */
function mergeUsage(tokens: Tokens, usage: unknown): Tokens {
  if (typeof usage !== "object" || usage === null) return tokens;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    inputTokens: Math.max(tokens.inputTokens, n(u.input_tokens)),
    outputTokens: Math.max(tokens.outputTokens, n(u.output_tokens)),
    cacheReadTokens: Math.max(tokens.cacheReadTokens, n(u.cache_read_input_tokens)),
    cacheWriteTokens: Math.max(tokens.cacheWriteTokens, n(u.cache_creation_input_tokens)),
  };
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

/**
 * 模型网关（#26）：沙箱经宿主机发来的 Messages 请求、平台自己发起的模型调用，都从这里转给上游提供方。
 *
 * - 转发前问准入（ModelAdmission），按提供方路由（ProviderRouting）挑上游，由提供方改写请求（剥字段、换 key）；
 * - 只在上游还没开始返回内容时出错才试下一个提供方；
 * - 流式响应按事件逐个转发，不攒整段；message_start 里的 id 和 model 换成我们的；
 * - 上游出错时给调用方回我们自己写的说明、状态码和参考号，原始报错存进 upstream_errors，只给管理员看；
 * - 每次调用报一次用量，中途断开、出错也报。
 */
export class ModelGateway {
  readonly #deps: GatewayDeps;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
  }

  /** 沙箱的 Messages 请求（/v1/messages），流式和非流式都行。返回给宿主机的响应。 */
  async messages(
    call: ModelCall,
    request: { headers: Headers; body: Record<string, unknown>; signal: AbortSignal },
  ): Promise<Response> {
    const sent = await this.#send(call, request.headers, request.body, request.signal);
    if (!sent.ok) return errorResponse(sent.failure);
    const { response, target, abort } = sent;
    const headers = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!isStream) {
      const { body, tokens } = await this.#rewriteJson(response, call.model);
      await this.#record(call, target.provider, tokens, true);
      return new Response(JSON.stringify(body), { status: response.status, headers });
    }
    return new Response(this.#rewriteStream(response, call, target, abort), {
      status: response.status,
      headers,
    });
  }

  /**
   * 平台自己发起的模型调用（起标题、判断是否在等输入……）：不经过沙箱，不流式，同样过准入和记录。
   * 返回上游的响应体（id、model 已经换成我们的）；出错时抛 GatewayError，里面只有我们自己写的说明。
   */
  async complete(call: ModelCall, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sent = await this.#send(
      call,
      new Headers(),
      { ...body, model: call.model, stream: false },
      new AbortController().signal,
    );
    if (!sent.ok) throw new GatewayError(sent.failure);
    const { body: result, tokens } = await this.#rewriteJson(sent.response, call.model);
    await this.#record(call, sent.target.provider, tokens, true);
    return result;
  }

  async #send(
    call: ModelCall,
    headers: Headers,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; response: Response; target: ProviderTarget; abort: AbortController }
    | { ok: false; failure: GatewayFailure }
  > {
    const admitted = await this.#deps.modelAdmission.admit(call);
    if (!admitted.ok) {
      return {
        ok: false,
        failure: { code: "model_rejected", status: 429, message: admitted.message },
      };
    }
    const targets = await this.#deps.providerRouting.route(call.model, call);
    if (targets.length === 0) {
      return {
        ok: false,
        failure: {
          code: "model_unavailable",
          status: 503,
          message: "尚未设置模型服务的 API key，请管理员在“设置 → 模型”中填写",
        },
      };
    }
    const doFetch = this.#deps.modelFetch ?? fetch;
    let failure: GatewayFailure | undefined;
    for (const target of targets) {
      const prepared = target.prepare({ headers, body });
      const abort = new AbortController();
      const onAbort = () => abort.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, HEADERS_TIMEOUT_MS);
      let response: Response;
      try {
        response = await doFetch(target.url("/v1/messages"), {
          method: "POST",
          headers: prepared.headers,
          body: JSON.stringify(prepared.body),
          signal: abort.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          // 调用方自己断了（沙箱停了）：不算上游出错，记一条没完成的用量。
          await this.#record(call, target.provider, ZERO, false);
          return {
            ok: false,
            failure: { code: "internal", status: 499, message: "请求已取消" },
          };
        }
        failure = await this.#fail(call, target, {
          status: null,
          body: timedOut ? "等待上游响应超时" : String(error),
          code: timedOut ? "timeout" : "model_unavailable",
        });
        continue;
      }
      clearTimeout(timer);
      if (response.ok) return { ok: true, response, target, abort };
      signal.removeEventListener("abort", onAbort);
      const text = await readLimited(response, MAX_ERROR_BODY);
      failure = await this.#fail(call, target, {
        status: response.status,
        body: text,
        retryAfter: response.headers.get("retry-after") ?? undefined,
      });
    }
    return { ok: false, failure: failure as GatewayFailure };
  }

  /** 记下一次上游出错：原始报错按参考号存库（只给管理员看），给调用方的只有说明、状态码和参考号。 */
  async #fail(
    call: ModelCall,
    target: ProviderTarget,
    raw: { status: number | null; body: string; retryAfter?: string; code?: ErrorCode },
    { record = true }: { record?: boolean } = {},
  ): Promise<GatewayFailure> {
    const ref = newRef();
    const code = raw.code ?? classify(raw.status, raw.body);
    const status =
      raw.status !== null && raw.status >= 400 && raw.status <= 599
        ? raw.status
        : code === "timeout"
          ? 504
          : 502;
    console.warn(
      `模型网关：提供方 ${target.provider} 出错（${raw.status ?? "连不上"}，参考号 ${ref}）`,
    );
    await this.#deps.db.insert(upstreamErrors).values({
      ref,
      userId: call.userId,
      sessionId: call.sessionId,
      provider: target.provider,
      code,
      status: raw.status,
      body: raw.body.slice(0, MAX_ERROR_BODY),
      createdAt: this.#deps.clock.now(),
    });
    if (raw.status === 401 || raw.status === 403) {
      await markProviderKeyRejected(this.#deps, target.provider);
    }
    // 流里出的错不在这里记：流结束时按已返回的用量记一条。
    if (record) await this.#record(call, target.provider, ZERO, false);
    return {
      code,
      status,
      ref,
      message: `${DESCRIPTIONS[code]}（${status} · 参考号 ${ref}）`,
      retryAfter: raw.retryAfter,
    };
  }

  async #record(call: ModelCall, provider: string, tokens: Tokens, complete: boolean) {
    const usage: ModelUsage = { ...call, provider, ...tokens, complete };
    try {
      await this.#deps.modelAdmission.record(usage);
    } catch (error) {
      console.error("模型网关：记用量失败", error);
    }
  }

  async #rewriteJson(response: Response, model: string) {
    const body = (await response.json()) as Record<string, unknown>;
    const out = { ...body, id: newMessageId(), model };
    return { body: out, tokens: mergeUsage(ZERO, body.usage) };
  }

  /** 流式响应：一个事件一个事件地转发，message_start 里换掉 id 和 model；上游的 error 事件换成我们的。 */
  #rewriteStream(
    response: Response,
    call: ModelCall,
    target: ProviderTarget,
    abort: AbortController,
  ): ReadableStream<Uint8Array> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const messageId = newMessageId();
    let buffer = "";
    let tokens = ZERO;
    let stopped = false;
    let failed = false;
    let recorded = false;
    const finish = async (complete: boolean) => {
      if (recorded) return;
      recorded = true;
      await this.#record(call, target.provider, tokens, complete);
    };

    const rewrite = async (block: string): Promise<string> => {
      const lines = block.split("\n");
      const event = lines
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim();
      const dataText = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      let data: Record<string, unknown> | undefined;
      try {
        data = dataText ? (JSON.parse(dataText) as Record<string, unknown>) : undefined;
      } catch {
        data = undefined;
      }
      const type = event ?? (data?.type as string | undefined);
      if (type === "error") {
        failed = true;
        const failure = await this.#fail(
          call,
          target,
          { status: null, body: dataText, code: "model_unavailable" },
          { record: false },
        );
        // 上游在流里报的错：类别按它说的类型分，原文不往下传。
        const upstreamType = (data?.error as { type?: string } | undefined)?.type;
        const code: ErrorCode =
          upstreamType === "rate_limit_error"
            ? "model_rate_limited"
            : upstreamType === "overloaded_error" || upstreamType === "api_error"
              ? "model_unavailable"
              : failure.code;
        const message = `${DESCRIPTIONS[code]}（参考号 ${failure.ref}）`;
        return `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: {
            type: upstreamType === "rate_limit_error" ? "rate_limit_error" : "api_error",
            message,
          },
        })}\n\n`;
      }
      if (!data) return `${block}\n\n`;
      if (type === "message_start" && typeof data.message === "object" && data.message !== null) {
        const message = data.message as Record<string, unknown>;
        tokens = mergeUsage(tokens, message.usage);
        const rewritten = { ...data, message: { ...message, id: messageId, model: call.model } };
        return `event: message_start\ndata: ${JSON.stringify(rewritten)}\n\n`;
      }
      if (type === "message_delta") tokens = mergeUsage(tokens, data.usage);
      if (type === "message_stop") stopped = true;
      return `${block}\n\n`;
    };

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.trim()) controller.enqueue(encoder.encode(await rewrite(buffer)));
              await finish(stopped && !failed);
              controller.close();
              return;
            }
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            let out = "";
            for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (block.trim()) out += await rewrite(block);
            }
            // 凑够一个完整的事件就发，不攒整段。
            if (out) {
              controller.enqueue(encoder.encode(out));
              return;
            }
          }
        } catch (error) {
          // 上游中途断了（或者沙箱停了）：已返回的用量照记，标未完成。
          await finish(false);
          controller.error(error);
        }
      },
      cancel: async () => {
        abort.abort();
        await reader.cancel().catch(() => undefined);
        await finish(false);
      },
    });
  }
}
