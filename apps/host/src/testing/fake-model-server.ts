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
/** 按脚本回复时的一步：思考、正文、要调的工具（Anthropic 的 tool_use）。 */
export interface ScriptedReply {
  thinking?: string;
  text?: string;
  tools?: { id: string; name: string; input: unknown }[];
}

export class FakeModelServer {
  readonly requests: RecordedRequest[] = [];
  /** 模型回的那句话（脚本用完以后也回它）。 */
  reply = "好的";
  /** 按顺序回的几步：第几次调模型就回第几步。 */
  script: ScriptedReply[] = [];
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
      // OpenAI Chat Completions（#188：dsh 的 pi-ai 适配器连自定义接口时说这个）
      if (req.method === "POST" && req.url?.split("?")[0]?.endsWith("/chat/completions")) {
        return this.#completions(res, body);
      }
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

  /** OpenAI Chat Completions 的请求（POST …/chat/completions）。 */
  completions(): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.method === "POST" && (r.path.split("?")[0] ?? "").endsWith("/chat/completions"),
    );
  }

  /** Chat Completions：回脚本里的正文（只认 text），流式时一块一块地回，最后带用量和 [DONE]。 */
  #completions(res: http.ServerResponse, body: unknown) {
    const step: ScriptedReply = this.script.shift() ?? { text: this.reply };
    const text = step.text ?? this.reply;
    const stream = (body as { stream?: unknown } | null)?.stream === true;
    const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          model: "fake",
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null, extra: object = {}) =>
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          model: "fake",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        })}\n\n`,
      );
    chunk({ role: "assistant", content: "" }, null);
    chunk({ content: text }, null);
    chunk({}, "stop");
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", choices: [], usage })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  }

  /** 调模型的请求（POST /v1/messages）的请求体。 */
  messages(): Record<string, unknown>[] {
    return this.requests
      .filter((r) => r.method === "POST" && r.path.endsWith("/v1/messages"))
      .map((r) => r.body as Record<string, unknown>);
  }

  #stream(res: http.ServerResponse) {
    const step: ScriptedReply = this.script.shift() ?? { text: this.reply };
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
    let index = 0;
    if (step.thinking) {
      send("content_block_start", {
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      send("content_block_delta", {
        index,
        delta: { type: "thinking_delta", thinking: step.thinking },
      });
      send("content_block_stop", { index: index++ });
    }
    if (step.text) {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: step.text } });
      send("content_block_stop", { index: index++ });
    }
    for (const tool of step.tools ?? []) {
      send("content_block_start", {
        index,
        content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
      });
      send("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
      });
      send("content_block_stop", { index: index++ });
    }
    send("message_delta", {
      delta: { stop_reason: step.tools?.length ? "tool_use" : "end_turn" },
      usage: { output_tokens: 5 },
    });
    send("message_stop", {});
    res.end();
  }
}
