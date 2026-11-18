import http from "node:http";
import type { AddressInfo } from "node:net";

/** 假模型服务收到的一个请求。 */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  /** 请求体（JSON 的解析出来，别的原样）。 */
  body: unknown;
}

/**
 * 扮演模型服务（Anthropic 的 Messages 格式，DeepSeek 的 /anthropic 接口也是它），给真的 dsh 用：
 * 把收到的每个请求记下来，/v1/messages 回一段固定的流式回复，别的路径（比如遥测上报）回 404。
 * dsh 用 DEEPSEEK_BASE_URL 指过来。
 */
export class FakeModelServer {
  readonly requests: RecordedRequest[] = [];
  /** 模型回的那句话。 */
  reply = "好的";
  readonly #server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // 不是 JSON：原样记
      }
      this.requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
      });
      if (req.method === "POST" && req.url?.endsWith("/v1/messages")) return this.#stream(res);
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":{"type":"not_found_error","message":"not found"}}');
    });
  });

  async start(): Promise<string> {
    await new Promise<void>((done) => this.#server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((done) => this.#server.close(() => done()));
  }

  /** 调模型的请求（POST /v1/messages）的请求体。 */
  messages(): Record<string, unknown>[] {
    return this.requests
      .filter((r) => r.method === "POST" && r.path.endsWith("/v1/messages"))
      .map((r) => r.body as Record<string, unknown>);
  }

  #stream(res: http.ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: string, data: object) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send("message_start", {
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "deepseek-chat",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: this.reply } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    send("message_stop", {});
    res.end();
  }
}
