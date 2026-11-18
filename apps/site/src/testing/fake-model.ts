/** 假的模型服务（Anthropic Messages 兼容），给模型网关的测试用：记下收到的请求，按脚本回。 */

export interface FakeModelRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export type FakeModelReply =
  /** 流式回一串事件。hold 为真时只先发第一个，等测试调 release() 再发剩下的。 */
  | { stream: Array<{ event: string; data: unknown }>; hold?: boolean; dropAfter?: number }
  /** 非流式回一个 JSON。 */
  | { json: Record<string, unknown> }
  /** 上游出错：状态码、响应体、响应头。 */
  | { status: number; body: string; headers?: Record<string, string> }
  /** 连不上。 */
  | { networkError: string };

/** 上游的用量。和 Anthropic 的字段一样。 */
export const UPSTREAM_USAGE = {
  input_tokens: 120,
  cache_read_input_tokens: 80,
  cache_creation_input_tokens: 20,
  output_tokens: 1,
};

/** 一段标准的流式回复：一段文字，最后的输出 token 是 outputTokens。 */
export function streamOf(text: string, outputTokens = 7): Array<{ event: string; data: unknown }> {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_upstream_9f8e7d",
          type: "message",
          role: "assistant",
          model: "upstream-internal-model-name",
          content: [],
          usage: UPSTREAM_USAGE,
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    ...[...text].map((ch) => ({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ch } },
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: outputTokens },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

export class FakeModelProvider {
  readonly requests: FakeModelRequest[] = [];
  readonly #replies: FakeModelReply[] = [];
  #release: (() => void) | undefined;
  /** 上游的流被调用方取消（沙箱断开）了没有。 */
  cancelled = false;

  /** 下一次请求回这个。没有脚本时流式回"收到。"。 */
  reply(reply: FakeModelReply): void {
    this.#replies.push(reply);
  }

  /** 放出 hold 住的剩下的事件。 */
  release(): void {
    this.#release?.();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    this.requests.push({ url, headers: new Headers(init?.headers), body });
    const reply = this.#replies.shift() ?? { stream: streamOf("收到。") };
    if ("networkError" in reply) throw new TypeError(reply.networkError);
    if ("status" in reply) {
      return new Response(reply.body, {
        status: reply.status,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    }
    const upstreamHeaders = {
      "x-request-id": "req_upstream_secret",
      "x-ratelimit-remaining": "42",
      server: "upstream-server/1.0",
    };
    if ("json" in reply) {
      return new Response(JSON.stringify(reply.json), {
        headers: { "content-type": "application/json", ...upstreamHeaders },
      });
    }
    const encoder = new TextEncoder();
    const blocks = reply.stream.map(
      (e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
    );
    const signal = init?.signal ?? undefined;
    const end = reply.dropAfter ?? blocks.length;
    let next = 0;
    // 按读的节奏一个个给：读到 dropAfter 那里时连接断开（像真的网络一样，断之前发出去的都已经到了）。
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (reply.hold && next === 1) {
          await new Promise<void>((resolve) => {
            this.#release = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          if (signal?.aborted) return;
        }
        if (next < end) {
          controller.enqueue(encoder.encode(blocks[next++] as string));
          return;
        }
        if (reply.dropAfter !== undefined) controller.error(new Error("upstream connection reset"));
        else controller.close();
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", ...upstreamHeaders },
    });
  };
}
