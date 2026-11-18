import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { streamOf, UPSTREAM_USAGE } from "../../testing/fake-model";
import { createTestApp, MODEL_KEY, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";
import { modelUsage, upstreamErrors } from "../db/schema";
import { GatewayError, ModelGateway } from "./gateway";

/** 模型网关（#26）：沙箱经宿主机发来的 Messages 请求，转给假的提供方 t.model。 */
describe("模型网关", () => {
  let t: TestApp;
  let browser: TestBrowser;
  let sessionId: string;
  let shortId: string;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "看看",
    });
    ({ shortId } = (await res.json()) as { shortId: string });
    await t.host.idle();
    sessionId = t.host.last("prepare_sandbox").sessionId;
  });
  afterAll(() => t.close());

  const call = (
    body: unknown,
    options: {
      session?: string;
      credential?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-seekcloud-session": options.session ?? sessionId,
      ...options.headers,
    };
    if (options.credential !== null) {
      headers.authorization = `Bearer ${options.credential ?? t.host.credential}`;
    }
    return t.request("/api/gateway/v1/messages", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  };
  const ask = (extra: Record<string, unknown> = {}) => ({
    model: "deepseek-flash",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "你好" }],
    ...extra,
  });
  /** 读完一个流式响应，按事件拆开。 */
  const events = async (res: Response) =>
    (await res.text())
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
        return { event, data };
      });
  const usageRows = () => t.db.select().from(modelUsage).where(eq(modelUsage.sessionId, sessionId));

  it("发给提供方之前剥掉 dsh 夹带的字段和请求头，不带 user_id，换上 key 和 SeekCloud 的 user-agent", async () => {
    const res = await call(
      ask({
        dsh_session_log: { turns: ["整段对话"] },
        dsh_plugin_packages: ["a", "b"],
        metadata: { user_id: "anon-9f2c", trace: "keep" },
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "write",
                input: { dsh_config: "用户自己的数据" },
              },
            ],
          },
        ],
      }),
      {
        headers: {
          "x-deepseek-harness-user-id": "anon-9f2c",
          "x-deepseek-harness-compact": "1",
          "user-agent": "dsh/0.2.2",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
          "x-something-else": "drop me",
        },
      },
    );
    expect(res.status).toBe(200);
    await res.text();
    const sent = t.model.requests.at(-1);
    expect(sent?.url).toBe("https://model.test/anthropic/v1/messages");
    expect(Object.keys(sent?.body ?? {}).filter((k) => k.startsWith("dsh_"))).toEqual([]);
    expect(sent?.body.metadata).toEqual({ trace: "keep" });
    // 消息内容里的 dsh_ 开头的键是用户自己的数据，不动
    expect(JSON.stringify(sent?.body.messages)).toContain("dsh_config");
    expect(sent?.body.model).toBe("deepseek-flash");
    const headers = Object.fromEntries(sent?.headers ?? []);
    expect(Object.keys(headers).filter((h) => h.startsWith("x-deepseek-harness"))).toEqual([]);
    expect(headers["x-api-key"]).toBe(MODEL_KEY);
    expect(headers["user-agent"]).toBe("SeekCloud/test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
    expect(headers["x-something-else"]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("认证：没有宿主机凭据、凭据不对、会话不在这台宿主机上、会话不存在或已停止，一律拒绝，不转发", async () => {
    const before = t.model.requests.length;
    expect((await call(ask(), { credential: null })).status).toBe(401);
    expect((await call(ask(), { credential: "wrong" })).status).toBe(401);
    expect((await call(ask(), { session: "not-a-uuid" })).status).toBe(403);
    expect((await call(ask(), { session: "00000000-0000-4000-8000-000000000000" })).status).toBe(
      403,
    );

    // 一个不在这台宿主机上的会话
    const other = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "另一个",
    });
    const { shortId: otherShort } = (await other.json()) as { shortId: string };
    await t.host.idle();
    const otherId = t.host.last("prepare_sandbox").sessionId;
    t.host.disown(otherId);
    expect((await call(ask(), { session: otherId })).status).toBe(403);
    // 已停止（归档）的会话
    await browser.post(`/api/sessions/${otherShort}/archive`);
    expect((await call(ask(), { session: otherId })).status).toBe(403);

    expect(t.model.requests.length).toBe(before);
    const body = await (await call(ask(), { credential: "wrong" })).json();
    expect(body).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "宿主机凭据无效或已过期" },
    });
  });

  it("请求体不是合法的 JSON、模型不认识：直接拒绝，不转发", async () => {
    const before = t.model.requests.length;
    expect((await call("{不是 JSON")).status).toBe(400);
    expect((await call("[1,2]")).status).toBe(400);
    expect((await call(ask({ model: "gpt-4o" }))).status).toBe(400);
    expect(t.model.requests.length).toBe(before);
  });

  it("流式响应一个事件一个事件地转发，不攒整段；id 和 model 换成我们的", async () => {
    t.model.reply({ stream: streamOf("你好世界"), hold: true });
    const res = await call(ask());
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // 上游只发了第一个事件，网关已经转过来了
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: message_start");
    const start = JSON.parse(/^data: (.*)$/m.exec(first)?.[1] ?? "{}");
    expect(start.message.model).toBe("deepseek-flash");
    expect(start.message.id).toMatch(/^msg_/);
    expect(start.message.id).not.toBe("msg_upstream_9f8e7d");
    t.model.release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const text = [...rest.matchAll(/"text":"(.)"/g)].map((m) => m[1]).join("");
    expect(text).toBe("你好世界");
    expect(rest).toContain("event: message_stop");
    expect(first + rest).not.toContain("upstream-internal-model-name");
  });

  it("上游的响应头只转发 content-type 和 retry-after：请求编号、限流额度、服务器名都不带", async () => {
    const res = await call(ask());
    await res.text();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    for (const name of ["x-request-id", "x-ratelimit-remaining", "server"]) {
      expect(res.headers.get(name), name).toBeNull();
    }
  });

  it("非流式：id、model 换成我们的", async () => {
    t.model.reply({
      json: {
        id: "msg_upstream_1",
        type: "message",
        model: "upstream-internal-model-name",
        content: [{ type: "text", text: "好" }],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    });
    const res = await call(ask({ stream: false }));
    const body = await res.json();
    expect(body.model).toBe("deepseek-flash");
    expect(body.id).toMatch(/^msg_/);
    expect(body.id).not.toBe("msg_upstream_1");
    expect(body.content).toEqual([{ type: "text", text: "好" }]);
  });

  it("每次调用记一条用量：会话、回合、提供方、模型、四种 token，不换算成钱", async () => {
    const before = (await usageRows()).length;
    t.model.reply({ stream: streamOf("嗯", 33) });
    await (await call(ask())).text();
    const rows = await usageRows();
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({
      purpose: "agent",
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: UPSTREAM_USAGE.input_tokens,
      outputTokens: 33,
      cacheReadTokens: UPSTREAM_USAGE.cache_read_input_tokens,
      cacheWriteTokens: UPSTREAM_USAGE.cache_creation_input_tokens,
      complete: true,
    });
  });

  it("上游中途断开：已返回的用量照记，标未完成", async () => {
    t.model.reply({ stream: streamOf("一二三四五"), dropAfter: 3 });
    const res = await call(ask());
    await expect(res.text()).rejects.toThrow();
    const last = (await usageRows()).at(-1);
    expect(last).toMatchObject({ inputTokens: UPSTREAM_USAGE.input_tokens, complete: false });
  });

  it("沙箱那头断开（比如沙箱停了）：上游的流跟着取消，已返回的用量照记，标未完成", async () => {
    t.model.cancelled = false;
    t.model.reply({ stream: streamOf("很长的回复"), hold: true });
    const res = await call(ask());
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    const last = (await usageRows()).at(-1);
    expect(last).toMatchObject({ inputTokens: UPSTREAM_USAGE.input_tokens, complete: false });
  });

  it("上游出错：沙箱只收到我们的说明、状态码和参考号；原始报错按参考号存下，管理员看得到", async () => {
    const leaky = JSON.stringify({
      error: {
        message:
          "Upstream https://internal-gw.deepseek.example/v1 failed for request req_77ab, key sk-live-1234…cdef",
      },
    });
    t.model.reply({
      status: 503,
      body: leaky,
      headers: { "retry-after": "7", "x-request-id": "req_77ab" },
    });
    const res = await call(ask());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("x-request-id")).toBeNull();
    const body = await res.json();
    const text = JSON.stringify(body);
    for (const leak of ["internal-gw", "req_77ab", "sk-live", "cdef"])
      expect(text).not.toContain(leak);
    const ref = /参考号 (\w+)/.exec(body.error.message)?.[1] as string;
    expect(body).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: `模型服务暂时不可用（503 · 参考号 ${ref}）` },
    });

    const [stored] = await t.db.select().from(upstreamErrors).where(eq(upstreamErrors.ref, ref));
    expect(stored).toMatchObject({ provider: "deepseek", status: 503, body: leaky, sessionId });
    const view = await (await browser.get(`/api/model-errors/${ref}`)).json();
    expect(view).toMatchObject({
      ref,
      code: "model_unavailable",
      status: 503,
      upstream: { status: 503, body: leaky },
    });
    expect((await usageRows()).at(-1)).toMatchObject({ complete: false, outputTokens: 0 });
  });

  it("上游在流里报错：换成我们的说明，原文不往下传", async () => {
    t.model.reply({
      stream: [
        ...streamOf("半").slice(0, 2),
        {
          event: "error",
          data: {
            type: "error",
            error: { type: "overloaded_error", message: "node gw-3.internal down" },
          },
        },
      ],
    });
    const all = await events(await call(ask()));
    const error = all.find((e) => e.event === "error");
    expect(JSON.stringify(error)).not.toContain("gw-3.internal");
    expect(error?.data.error.message).toMatch(/^模型服务暂时不可用（参考号 \w+）$/);
  });

  it("上下文太长、限流、连不上：各归各的类别", async () => {
    t.model.reply({
      status: 400,
      body: '{"error":{"message":"prompt is too long: 1200000 tokens"}}',
    });
    expect((await (await call(ask())).json()).error.message).toMatch(
      /^对话超出模型的上下文长度（400/,
    );
    t.model.reply({ status: 429, body: "{}" });
    expect((await (await call(ask())).json()).error).toMatchObject({ type: "rate_limit_error" });
    t.model.reply({ networkError: "connect ECONNREFUSED 10.1.2.3:443" });
    const res = await call(ask());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("10.1.2.3");
    expect(body.error.message).toMatch(/^模型服务暂时不可用（502 · 参考号/);
  });

  it("上游说 key 不对：类别是模型服务拒绝，设置里提示管理员检查 key；换了 key 以后提示消失", async () => {
    t.model.reply({
      status: 401,
      body: '{"error":{"message":"Authentication Fails (sk-live...)"}}',
    });
    const body = await (await call(ask())).json();
    expect(body.error.message).toMatch(/^模型服务拒绝了请求（401/);
    const status = await (await browser.get("/api/settings/model-provider")).json();
    expect(status.keyRejectedAt).not.toBeNull();

    await browser.request("/api/settings/model-provider/key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: MODEL_KEY }),
    });
    expect(
      (await (await browser.get("/api/settings/model-provider")).json()).keyRejectedAt,
    ).toBeNull();
  });

  it("上游的原始报错保存 30 天，过了就删掉", async () => {
    t.model.reply({ status: 500, body: "old" });
    const ref = /参考号 (\w+)/.exec(
      (await (await call(ask())).json()).error.message,
    )?.[1] as string;
    t.clock.advance(29 * 24 * 60 * 60_000);
    await t.runMaintenance();
    expect((await browser.get(`/api/model-errors/${ref}`)).status).toBe(200);
    t.clock.advance(2 * 24 * 60 * 60_000);
    await t.runMaintenance();
    // 31 天过去，登录也过期了（30 天）：重新登录
    browser = await t.admin();
    expect((await browser.get(`/api/model-errors/${ref}`)).status).toBe(404);
  });

  it("别人（另一个会话的主人）按参考号查不到原始报错", async () => {
    expect((await browser.get("/api/model-errors/nonexistent")).status).toBe(404);
    expect((await t.browser().get("/api/model-errors/nonexistent")).status).toBe(401);
  });

  it("平台自己发起的调用走同一条路：同样剥字段、记用量，出错时抛的错里没有上游的文字", async () => {
    const gateway = new ModelGateway(t.deps);
    const userId = (await (await browser.get("/api/me")).json()).id;
    t.model.reply({
      json: {
        id: "msg_upstream_2",
        model: "upstream-internal-model-name",
        content: [{ type: "text", text: "首页改成中文" }],
        usage: { input_tokens: 9, output_tokens: 4 },
      },
    });
    const result = await gateway.complete(
      { purpose: "title", userId, sessionId, turnId: null, model: "deepseek-flash" },
      { max_tokens: 50, messages: [{ role: "user", content: "起个标题" }], dsh_extra: 1 },
    );
    expect(result.model).toBe("deepseek-flash");
    expect(t.model.requests.at(-1)?.body).toMatchObject({ stream: false, model: "deepseek-flash" });
    expect(t.model.requests.at(-1)?.body.dsh_extra).toBeUndefined();
    expect((await usageRows()).at(-1)).toMatchObject({
      purpose: "title",
      inputTokens: 9,
      outputTokens: 4,
    });

    t.model.reply({ status: 500, body: "boom at db-7.internal" });
    const failure = await gateway
      .complete(
        { purpose: "title", userId, sessionId, turnId: null, model: "deepseek-flash" },
        { max_tokens: 50, messages: [] },
      )
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GatewayError);
    expect(JSON.stringify((failure as GatewayError).failure)).not.toContain("db-7");
  });

  it("会话在运行中时，用量记在当前回合上", async () => {
    t.host.manual = true;
    await browser.post(`/api/sessions/${shortId}/messages`, { text: "再来" });
    const turnId = t.host.last("start_turn").turnId;
    await (await call(ask())).text();
    expect((await usageRows()).at(-1)?.turnId).toBe(turnId);
    t.host.manual = false;
  });
});

describe("还没填模型服务的 key", () => {
  it("发起会话时报错，说明去设置里填；网关也拒绝", async () => {
    const t = await createTestApp({ modelKey: false });
    const { browser } = await t.adminWithGitHub("octo", "octo/app");
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "看看",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "model_not_configured",
        message: "尚未设置模型服务的 API key，请在“设置 → 模型”中填写",
      },
    });
    expect(await (await browser.get("/api/settings/model-provider")).json()).toMatchObject({
      keySet: false,
      keySetAt: null,
    });
    await t.close();
  });
});
