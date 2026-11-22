import { randomBytes } from "node:crypto";
import { type ErrorCode, type ModelProtocol, parseModelRef } from "@seekcloud/protocol";
import type { AppDeps } from "../app";
import type { ModelCall, ModelUsage, ProviderTarget } from "../ports";
import {
  DESCRIPTIONS,
  errorResponse,
  GatewayError,
  type GatewayFailure,
  MAX_ERROR_BODY,
  readLimited,
  recordUpstreamFailure,
  type UpstreamRaw,
} from "./failures";
import {
  mergeAnthropicUsage as mergeUsage,
  type Tokens,
  UsageMeter,
  usageOfBody,
  ZERO_TOKENS as ZERO,
} from "./usage";

/** 上游响应头之前最多等这么久（流开始以后不限时，长的推理可以跑很久）。 */
const HEADERS_TIMEOUT_MS = 5 * 60_000;
/** 给沙箱的响应只转发这几个上游响应头（ADR 0007）。 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after"];

export type GatewayDeps = Pick<AppDeps, "db" | "clock" | "modelAdmission" | "providerRouting"> & {
  /** 发给上游用的 fetch，测试里换成假的提供方。 */
  modelFetch?: typeof fetch;
};

/** 我们自己的消息 ID：不同平台的编号格式不一样，从编号能看出走的是哪家（ADR 0007）。 */
function newMessageId(): string {
  return `msg_${randomBytes(18).toString("base64url").replace(/[-_]/g, "x")}`;
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

  /**
   * 沙箱的 Messages 请求（/v1/messages），流式和非流式都行。返回给宿主机的响应。
   * providers：请求里引用了上传的文件时，只用存着这些文件的提供方（文件只在传上去的那个提供方那里有）。
   */
  async messages(
    call: ModelCall,
    request: {
      headers: Headers;
      body: Record<string, unknown>;
      signal: AbortSignal;
      providers?: ReadonlySet<string>;
    },
  ): Promise<Response> {
    const sent = await this.#send(
      call,
      request.headers,
      request.body,
      request.signal,
      request.providers,
    );
    if (!sent.ok) return errorResponse(sent.failure);
    const { response, target, abort } = sent;
    const headers = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!isStream) {
      const { body, tokens } = await this.#rewriteJson(response, wireModel(call.model));
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
      { ...body, model: wireModel(call.model), stream: false },
      new AbortController().signal,
    );
    if (!sent.ok) throw new GatewayError(sent.failure);
    const { body: result, tokens } = await this.#rewriteJson(sent.response, wireModel(call.model));
    await this.#record(call, sent.target.provider, tokens, true);
    return result;
  }

  /**
   * 每个提供方一个透明转发（#113）：沙箱里的 dsh 用自己的适配器说各家的协议，请求体原样转给这个提供方的地址
   * （path 接在后面），网关只换上真正的 key（认证头按协议放）、问准入、记用量。流式原样传回，边传边按协议读用量。
   * Chat Completions 的流式请求补上 stream_options.include_usage（不然没有用量）。不跟重定向。
   */
  async passThrough(
    call: ModelCall,
    request: {
      provider: string;
      protocol: ModelProtocol;
      path: string;
      search: string;
      headers: Headers;
      body: Record<string, unknown>;
      signal: AbortSignal;
    },
  ): Promise<Response> {
    const admitted = await this.#deps.modelAdmission.admit(call);
    if (!admitted.ok) {
      return errorResponse({ code: "model_rejected", status: 429, message: admitted.message });
    }
    const target = (await this.#deps.providerRouting.route(call.model, call)).find(
      (t) => t.provider === request.provider,
    );
    if (!target) {
      return errorResponse({
        code: "model_unavailable",
        status: 503,
        message:
          "这个模型服务没有可用的 key、已停用，或者没有这个模型，请管理员在“设置 → 模型”中检查",
      });
    }
    const body =
      request.protocol === "openai-completions" && request.body.stream === true
        ? {
            ...request.body,
            stream_options: {
              ...(typeof request.body.stream_options === "object"
                ? request.body.stream_options
                : {}),
              include_usage: true,
            },
          }
        : request.body;
    const headers = target.headers(request.path, request.headers);
    headers.set("content-type", "application/json");
    const sent = await this.#fetchUpstream(call, target, {
      url: `${target.url(request.path)}${request.search}`,
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!sent.ok) return errorResponse(sent.failure);
    const { response, abort } = sent;
    const out = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) out.set(name, value);
    }
    const meter = new UsageMeter(request.protocol);
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      await this.#record(call, target.provider, usageOfBody(request.protocol, parsed), true);
      return new Response(text, { status: response.status, headers: out });
    }
    return new Response(this.#meterStream(response, call, target, meter, abort), {
      status: response.status,
      headers: out,
    });
  }

  /**
   * 平台自己发起的调用（判断是否在等输入、置顶的短标题）：按模型的协议发一个最简单的文字请求，拿回文字。
   * 不开思考（协议支持时）、不流式，照常过准入、记用量。出错抛 GatewayError。
   */
  async text(call: ModelCall, ask: { prompt: string; maxTokens: number }): Promise<string> {
    const target = (await this.#deps.providerRouting.route(call.model, call))[0];
    const protocol = target?.protocol ?? "anthropic-messages";
    if (protocol === "anthropic-messages") {
      const result = await this.complete(call, {
        max_tokens: ask.maxTokens,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: ask.prompt }],
      });
      return textOfBody(protocol, result);
    }
    const admitted = await this.#deps.modelAdmission.admit(call);
    if (!admitted.ok) {
      throw new GatewayError({ code: "model_rejected", status: 429, message: admitted.message });
    }
    if (!target) {
      throw new GatewayError({
        code: "model_unavailable",
        status: 503,
        message: "没有可用的模型服务",
      });
    }
    const model = wireModel(call.model);
    const { path, body } = platformRequest(protocol, model, ask);
    const headers = target.headers(path, new Headers());
    headers.set("content-type", "application/json");
    const sent = await this.#fetchUpstream(call, target, {
      url: target.url(path),
      headers,
      body: JSON.stringify(body),
      signal: new AbortController().signal,
    });
    if (!sent.ok) throw new GatewayError(sent.failure);
    const result = (await sent.response.json().catch(() => ({}))) as Record<string, unknown>;
    await this.#record(call, target.provider, usageOfBody(protocol, result), true);
    return textOfBody(protocol, result);
  }

  /** 发一个请求给上游，等到响应头：超时、连不上、出错（包括重定向）都记成上游出错。 */
  async #fetchUpstream(
    call: ModelCall,
    target: ProviderTarget,
    request: { url: string; headers: Headers; body: string; signal: AbortSignal },
  ): Promise<
    | { ok: true; response: Response; abort: AbortController }
    | { ok: false; failure: GatewayFailure }
  > {
    const doFetch = this.#deps.modelFetch ?? fetch;
    const abort = new AbortController();
    const onAbort = () => abort.abort(request.signal.reason);
    request.signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, HEADERS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: abort.signal,
        redirect: "manual",
      });
    } catch (error) {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      if (request.signal.aborted) {
        await this.#record(call, target.provider, ZERO, false);
        return { ok: false, failure: { code: "internal", status: 499, message: "请求已取消" } };
      }
      const failure = await this.#fail(call, target, {
        status: null,
        body: timedOut ? "等待上游响应超时" : String(error),
        code: timedOut ? "timeout" : "model_unavailable",
      });
      return { ok: false, failure };
    }
    clearTimeout(timer);
    if (response.ok) return { ok: true, response, abort };
    request.signal.removeEventListener("abort", onAbort);
    const text =
      response.status >= 300 && response.status < 400
        ? `上游要求重定向到 ${response.headers.get("location") ?? "（没有地址）"}，网关不跟重定向`
        : await readLimited(response, MAX_ERROR_BODY);
    const failure = await this.#fail(call, target, {
      status: response.status,
      body: text,
      retryAfter: response.headers.get("retry-after") ?? undefined,
    });
    return { ok: false, failure };
  }

  /** 透明转发的流：字节原样传回，同时按协议读出用量；结束、断开、取消时记一条。 */
  #meterStream(
    response: Response,
    call: ModelCall,
    target: ProviderTarget,
    meter: UsageMeter,
    abort: AbortController,
  ): ReadableStream<Uint8Array> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let recorded = false;
    const finish = async (complete: boolean) => {
      if (recorded) return;
      recorded = true;
      await this.#record(call, target.provider, meter.tokens, complete);
    };
    const parse = (text: string) => {
      buffer += text.replace(/\r\n/g, "\n");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = block.split("\n");
        const event = lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = lines
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) meter.feed(event, data);
      }
    };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            parse(`${decoder.decode()}\n\n`);
            await finish(meter.finished);
            controller.close();
            return;
          }
          parse(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        } catch (error) {
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

  async #send(
    call: ModelCall,
    headers: Headers,
    body: Record<string, unknown>,
    signal: AbortSignal,
    providers?: ReadonlySet<string>,
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
    const routed = await this.#deps.providerRouting.route(call.model, call);
    const targets = providers ? routed.filter((t) => providers.has(t.provider)) : routed;
    if (routed.length > 0 && targets.length === 0) {
      return {
        ok: false,
        failure: {
          code: "model_unavailable",
          status: 503,
          message: "请求里引用的文件所在的模型服务现在不可用，请重新上传",
        },
      };
    }
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

  /** 记下一次上游出错（failures.ts）。流里出的错不在这里记用量：流结束时按已返回的用量记一条。 */
  async #fail(
    call: ModelCall,
    target: ProviderTarget,
    raw: UpstreamRaw,
    { record = true }: { record?: boolean } = {},
  ): Promise<GatewayFailure> {
    const failure = await recordUpstreamFailure(this.#deps, call, target.provider, raw);
    if (record) await this.#record(call, target.provider, ZERO, false);
    return failure;
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
        const rewritten = {
          ...data,
          message: { ...message, id: messageId, model: wireModel(call.model) },
        };
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

/** 回给调用方的模型名：它请求的那个（"提供方/模型"里的模型），不是上游自己报的名字。 */
const wireModel = (ref: string) => parseModelRef(ref).model;

/** 平台调用在各协议下最简单的文字请求：路径接在提供方的地址后面。 */
export function platformRequest(
  protocol: ModelProtocol,
  model: string,
  ask: { prompt: string; maxTokens: number },
): { path: string; body: Record<string, unknown> } {
  switch (protocol) {
    case "anthropic-messages":
      return {
        path: "/v1/messages",
        body: {
          model,
          max_tokens: ask.maxTokens,
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: ask.prompt }],
        },
      };
    case "openai-completions":
      return {
        path: "/chat/completions",
        body: {
          model,
          max_tokens: ask.maxTokens,
          messages: [{ role: "user", content: ask.prompt }],
        },
      };
    case "openai-responses":
      return {
        path: "/responses",
        body: { model, max_output_tokens: Math.max(16, ask.maxTokens), input: ask.prompt },
      };
    case "google-generative-ai":
      return {
        path: `/models/${encodeURIComponent(model)}:generateContent`,
        body: {
          contents: [{ role: "user", parts: [{ text: ask.prompt }] }],
          generationConfig: { maxOutputTokens: ask.maxTokens },
        },
      };
  }
}

/** 各协议的回答里的文字。 */
export function textOfBody(protocol: ModelProtocol, body: Record<string, unknown>): string {
  const text = (part: unknown, type?: string) => {
    const p = part as { type?: unknown; text?: unknown } | null;
    return p && typeof p.text === "string" && (type === undefined || p.type === type) ? p.text : "";
  };
  switch (protocol) {
    case "anthropic-messages":
      return Array.isArray(body.content) ? body.content.map((b) => text(b, "text")).join("") : "";
    case "openai-completions": {
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message
        ?.content;
      return typeof content === "string" ? content : "";
    }
    case "openai-responses": {
      if (typeof body.output_text === "string") return body.output_text;
      const output = Array.isArray(body.output) ? body.output : [];
      return output
        .flatMap((item) => {
          const content = (item as { content?: unknown }).content;
          return Array.isArray(content) ? content : [];
        })
        .map((part) => text(part, "output_text"))
        .join("");
    }
    case "google-generative-ai": {
      const candidates = Array.isArray(body.candidates) ? body.candidates : [];
      const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content
        ?.parts;
      return Array.isArray(parts) ? parts.map((p) => text(p)).join("") : "";
    }
  }
}
