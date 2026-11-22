import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayRequest, startSession } from "../../testing/gateway-client";
import { createTestApp, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";
import { modelProviders, modelUsage, upstreamErrors } from "../db/schema";
import { ModelGateway } from "./gateway";
import { modelOfRequest, protocolOfPath, safeProviderPath, upstreamSearch } from "./provider-path";

/** 每个提供方一个透明转发（#113）：认证头按协议放、地址是 基础 URL + 剩下的路径、流式原样传回、用量按协议记。 */

const PROVIDERS = [
  { id: "p-chat", api: "openai-completions", key: "chat-key-0123456789" },
  { id: "p-resp", api: "openai-responses", key: "resp-key-0123456789" },
  { id: "p-anth", api: "anthropic-messages", key: "anth-key-0123456789" },
  { id: "p-gem", api: "google-generative-ai", key: "gem-key-0123456789" },
] as const;

describe("透明转发", () => {
  let t: TestApp;
  let browser: TestBrowser;
  let sessionId: string;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
    for (const p of PROVIDERS) {
      const res = await browser.post("/api/settings/model-providers", {
        kind: "custom",
        id: p.id,
        api: p.api,
        baseUrl: `https://${p.id}.example/v1`,
        apiKey: p.key,
        models: [{ id: "m-1", input: ["text"] }],
      });
      expect(res.status).toBe(201);
    }
    ({ sessionId } = await startSession(t, browser, "octo/app"));
  });
  afterAll(() => t.close());

  const forward = (provider: string, path: string, body: unknown, headers = {}) =>
    gatewayRequest(t, sessionId, `/providers/${provider}${path}`, {
      body,
      headers: {
        cookie: "must-not-leak=1",
        "x-api-key": "session-token-must-not-leak",
        ...headers,
      },
    });
  const lastUsage = async () =>
    (await t.deps.db.select().from(modelUsage).orderBy(desc(modelUsage.createdAt)).limit(1))[0];
  const lastRequest = () => t.model.requests.at(-1);
  const noLeaks = (headers: Headers | undefined) => {
    const all = [...(headers ?? new Headers())].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(all).not.toContain("must-not-leak");
    expect(all).not.toContain(t.host.credential);
    expect(all).not.toContain(sessionId);
  };

  it("Chat Completions 非流式：Bearer 换成真的 key，地址接上路径，响应原样回来，用量减掉读缓存", async () => {
    const upstream = {
      id: "chatcmpl-upstream",
      model: "m-1",
      choices: [{ index: 0, message: { role: "assistant", content: "好" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    };
    t.model.reply({ json: upstream });
    const res = await forward("p-chat", "/chat/completions", { model: "m-1", messages: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream);
    const req = lastRequest();
    expect(req?.url).toBe("https://p-chat.example/v1/chat/completions");
    expect(req?.headers.get("authorization")).toBe("Bearer chat-key-0123456789");
    noLeaks(req?.headers);
    expect(req?.body).toEqual({ model: "m-1", messages: [] });
    expect(await lastUsage()).toMatchObject({
      purpose: "agent",
      provider: "p-chat",
      model: "p-chat/m-1",
      inputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 7,
      complete: true,
    });
  });

  it("Chat Completions 流式：补上 stream_options.include_usage，字节原样传回，最后一块的用量记下", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ];
    t.model.reply({ sse });
    const res = await forward("p-chat", "/chat/completions", {
      model: "m-1",
      stream: true,
      stream_options: { other: 1 },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe(sse.join(""));
    expect(lastRequest()?.body).toMatchObject({
      stream_options: { other: 1, include_usage: true },
    });
    expect(await lastUsage()).toMatchObject({ inputTokens: 20, outputTokens: 2, complete: true });
  });

  it("Responses 流式：用量在 response.completed 里", async () => {
    const sse = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"嗯"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":9,"input_tokens_details":{"cached_tokens":10}}}}\n\n',
    ];
    t.model.reply({ sse });
    const res = await forward("p-resp", "/responses", { model: "m-1", stream: true });
    expect(await res.text()).toBe(sse.join(""));
    expect(lastRequest()?.url).toBe("https://p-resp.example/v1/responses");
    expect(lastRequest()?.headers.get("authorization")).toBe("Bearer resp-key-0123456789");
    expect(await lastUsage()).toMatchObject({
      provider: "p-resp",
      inputTokens: 40,
      cacheReadTokens: 10,
      outputTokens: 9,
      complete: true,
    });
  });

  it("Anthropic Messages：x-api-key，anthropic-version 照转；用量来自 message_start 和 message_delta", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":30,"cache_read_input_tokens":5,"output_tokens":1}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    t.model.reply({ sse });
    const res = await forward(
      "p-anth",
      "/v1/messages",
      { model: "m-1", stream: true },
      { "anthropic-version": "2023-06-01", "anthropic-beta": "x" },
    );
    expect(await res.text()).toBe(sse.join(""));
    const req = lastRequest();
    expect(req?.url).toBe("https://p-anth.example/v1/v1/messages");
    expect(req?.headers.get("x-api-key")).toBe("anth-key-0123456789");
    expect(req?.headers.get("anthropic-beta")).toBe("x");
    expect(req?.headers.get("authorization")).toBeNull();
    expect(await lastUsage()).toMatchObject({
      provider: "p-anth",
      inputTokens: 30,
      cacheReadTokens: 5,
      outputTokens: 12,
      complete: true,
    });
  });

  it("Gemini：模型在路径里，x-goog-api-key；查询参数里沙箱的假 key 去掉，alt=sse 留着；思考的 token 算进输出", async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"好"}]}}],"usageMetadata":{"promptTokenCount":10}}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":4,"cachedContentTokenCount":2}}\n\n',
    ];
    t.model.reply({ sse });
    const res = await forward(
      "p-gem",
      "/models/m-1:streamGenerateContent?alt=sse&key=fake-sandbox-key",
      {
        contents: [],
      },
    );
    expect(await res.text()).toBe(sse.join(""));
    const req = lastRequest();
    expect(req?.url).toBe("https://p-gem.example/v1/models/m-1:streamGenerateContent?alt=sse");
    expect(req?.headers.get("x-goog-api-key")).toBe("gem-key-0123456789");
    expect(await lastUsage()).toMatchObject({
      provider: "p-gem",
      model: "p-gem/m-1",
      inputTokens: 8,
      cacheReadTokens: 2,
      outputTokens: 7,
      complete: true,
    });
  });

  it("流中途断开：已读到的用量照记，标未完成", async () => {
    t.model.reply({ sse: ['data: {"choices":[{"delta":{"content":"一"}}]}\n\n'] });
    const res = await forward("p-chat", "/chat/completions", { model: "m-1", stream: true });
    await res.text();
    expect(await lastUsage()).toMatchObject({ provider: "p-chat", complete: false });
  });

  it("上游出错：回我们的说明和参考号，原始报错只给管理员；401 时设置里提示检查 key；不跟重定向", async () => {
    t.model.reply({ status: 401, body: '{"error":{"message":"bad key chat-key-0123456789"}}' });
    const res = await forward("p-chat", "/chat/completions", { model: "m-1" });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toMatch(/参考号/);
    expect(text).not.toContain("bad key");
    const [row] = await t.deps.db
      .select()
      .from(upstreamErrors)
      .orderBy(desc(upstreamErrors.createdAt))
      .limit(1);
    expect(row?.provider).toBe("p-chat");
    const [provider] = await t.deps.db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.slug, "p-chat"));
    expect(provider?.keyRejectedAt).not.toBeNull();

    t.model.reply({ status: 302, body: "", headers: { location: "https://elsewhere.example/" } });
    const redirected = await forward("p-chat", "/chat/completions", { model: "m-1" });
    expect(redirected.status).toBeGreaterThanOrEqual(400);
    expect(t.model.requests.at(-1)?.url).toBe("https://p-chat.example/v1/chat/completions");
  });

  it("路径、模型、提供方不对：拒绝，不发给上游", async () => {
    const before = t.model.requests.length;
    // .. 在地址里先被规整掉（落到别的提供方 ID 上，没有这个提供方）；编码过的斜杠拒绝
    expect((await forward("p-chat", "/../secret/chat/completions", { model: "m-1" })).status).toBe(
      503,
    );
    expect((await forward("p-chat", "/a%2f..%2fchat/completions", { model: "m-1" })).status).toBe(
      400,
    );
    expect((await forward("p-chat", "/files", { model: "m-1" })).status).toBe(404);
    expect((await forward("p-chat", "/chat/completions", { messages: [] })).status).toBe(400);
    expect((await forward("p-chat", "/chat/completions", { model: "not-listed" })).status).toBe(
      503,
    );
    expect((await forward("nobody", "/chat/completions", { model: "m-1" })).status).toBe(503);
    await browser.request("/api/settings/model-providers/p-resp", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((await forward("p-resp", "/responses", { model: "m-1" })).status).toBe(503);
    expect(t.model.requests.length).toBe(before);
    // 没有宿主机凭据：不转
    const anon = await t.request("/api/gateway/providers/p-chat/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m-1" }),
    });
    expect(anon.status).toBe(401);
  });

  it("平台调用按协议发最简单的文字请求，拿回文字（Anthropic 关掉思考）", async () => {
    const gateway = new ModelGateway(t.deps);
    const call = (ref: string) => ({
      purpose: "waiting_check" as const,
      userId: null,
      sessionId: null,
      turnId: null,
      model: ref,
    });
    const cases = [
      {
        ref: "p-chat/m-1",
        reply: {
          choices: [{ message: { content: "是" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        },
        url: "https://p-chat.example/v1/chat/completions",
      },
      {
        ref: "p-anth/m-1",
        reply: {
          content: [{ type: "text", text: "是" }],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
        url: "https://p-anth.example/v1/v1/messages",
      },
      {
        ref: "p-gem/m-1",
        reply: { candidates: [{ content: { parts: [{ text: "是" }] } }] },
        url: "https://p-gem.example/v1/models/m-1:generateContent",
      },
    ];
    for (const c of cases) {
      t.model.reply({ json: c.reply });
      expect(await gateway.text(call(c.ref), { prompt: "问", maxTokens: 8 }), c.ref).toBe("是");
      expect(lastRequest()?.url, c.ref).toBe(c.url);
    }
    expect(t.model.requests.at(-2)?.body).toMatchObject({
      thinking: { type: "disabled" },
      max_tokens: 8,
    });
    await browser.request("/api/settings/model-providers/p-resp", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    t.model.reply({ json: { output: [{ content: [{ type: "output_text", text: "否" }] }] } });
    expect(await gateway.text(call("p-resp/m-1"), { prompt: "问", maxTokens: 8 })).toBe("否");
    expect(lastRequest()?.body).toMatchObject({ input: "问", max_output_tokens: 16 });
  });
});

describe("透明转发的路径", () => {
  it.each([
    ["/chat/completions", "/chat/completions"],
    ["/v1/messages", "/v1/messages"],
    [
      "/models/gemini-2.5-pro:streamGenerateContent",
      "/models/gemini-2.5-pro:streamGenerateContent",
    ],
    ["/../x", undefined],
    ["/a/./b", undefined],
    ["/a%2Fb", undefined],
    ["/a%5cb", undefined],
    ["/a\\b", undefined],
    ["/%2e%2e/x", undefined],
    ["relative", undefined],
    ["/a b", undefined],
  ])("%j → %j", (raw, expected) => {
    expect(safeProviderPath(raw)).toBe(expected);
  });

  it("协议按 SDK 拼的路径认；模型从请求体或者 Gemini 的路径里取", () => {
    expect(protocolOfPath("/v1/chat/completions")).toBe("openai-completions");
    expect(protocolOfPath("/responses")).toBe("openai-responses");
    expect(protocolOfPath("/v1/messages/count_tokens")).toBe("anthropic-messages");
    expect(protocolOfPath("/models/g:countTokens")).toBe("google-generative-ai");
    expect(protocolOfPath("/models")).toBeUndefined();
    expect(modelOfRequest("google-generative-ai", "/models/gemini-x:generateContent", {})).toBe(
      "gemini-x",
    );
    expect(modelOfRequest("openai-completions", "/chat/completions", { model: "gpt" })).toBe("gpt");
    expect(upstreamSearch("?alt=sse&key=abc")).toBe("?alt=sse");
    expect(upstreamSearch("?key=abc")).toBe("");
  });
});
