/**
 * 假的模型服务（Anthropic Messages 兼容，加上 Files 接口和 DeepSeek 的联网搜索），给模型网关的测试用：
 * 记下收到的请求，按脚本回。没有脚本时：Messages 流式回"收到。"，Files 真的存在内存里，搜索回两条结果。
 */

export interface FakeModelRequest {
  url: string;
  method: string;
  headers: Headers;
  /** JSON 请求体；不是 JSON 时为空对象。 */
  body: Record<string, unknown>;
  /** multipart 的请求体（上传文件）。 */
  form?: FormData;
}

/** 假的搜索结果，夹带着上游自己的字段（网关不该带回沙箱）。 */
export const FAKE_SEARCH_RESULTS = [
  {
    url: "https://example.com/a",
    title: "第一条",
    snippet: "摘要一",
    date: "2026-11-01",
    score: 0.9,
    internal_id: "upstream-secret-id",
  },
  { url: "https://example.com/b", title: "第二条", snippet: "摘要二", date: null },
];

export type FakeModelReply =
  /** 流式回一串事件。hold 为真时只先发第一个，等测试调 release() 再发剩下的。 */
  | { stream: Array<{ event: string; data: unknown }>; hold?: boolean; dropAfter?: number }
  /** 非流式回一个 JSON。 */
  | { json: Record<string, unknown> }
  /** 流式原样回这几段文字（一段一块），给 OpenAI、Gemini 这类没有 event 行的流用。 */
  | { sse: string[] }
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
  /** 传上来的文件。 */
  readonly files = new Map<string, { filename: string; mimeType: string; size: number }>();
  readonly #replies: FakeModelReply[] = [];
  #nextFile = 1;
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
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const contentType = headers.get("content-type") ?? "";
    let body: Record<string, unknown> = {};
    let form: FormData | undefined;
    if (contentType.startsWith("multipart/form-data")) {
      form = await new Response(init?.body, {
        headers: { "content-type": contentType },
      }).formData();
    } else if (init?.body) {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
    }
    this.requests.push({ url, method, headers, body, form });
    const path = new URL(url).pathname;
    const reply = this.#replies.shift() ?? this.#default(method, path, form);
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
    if ("sse" in reply) {
      const chunks = reply.sse.map((c) => new TextEncoder().encode(c));
      return new Response(
        new ReadableStream<Uint8Array>({
          pull: (controller) => {
            const next = chunks.shift();
            if (next) controller.enqueue(next);
            else controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream", ...upstreamHeaders } },
      );
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

  /** 没有脚本时的回复：按接口来。 */
  #default(method: string, path: string, form: FormData | undefined): FakeModelReply {
    if (path.endsWith("/v1/tools/search")) return { json: { results: FAKE_SEARCH_RESULTS } };
    if (path.endsWith("/v1/files") && method === "POST") {
      const file = form?.get("file");
      if (!(file instanceof File)) return { status: 400, body: '{"error":"no file"}' };
      const id = `file_fake${this.#nextFile++}`;
      this.files.set(id, { filename: file.name, mimeType: file.type, size: file.size });
      return {
        json: {
          type: "file",
          id,
          filename: file.name,
          mime_type: file.type,
          size_bytes: file.size,
          created_at: new Date(Date.UTC(2026, 10, 18, 0, 0, this.#nextFile)).toISOString(),
          downloadable: false,
          // 上游自己的字段，网关不该带回沙箱。
          organization_id: "org_upstream_secret",
        },
      };
    }
    const fileId = /\/v1\/files\/([^/]+)$/.exec(path)?.[1];
    if (fileId && method === "DELETE") {
      if (!this.files.delete(decodeURIComponent(fileId))) {
        return {
          status: 404,
          body: '{"error":{"type":"not_found_error","message":"no such file"}}',
        };
      }
      return { json: { id: decodeURIComponent(fileId), type: "file_deleted" } };
    }
    return { stream: streamOf("收到。") };
  }
}
