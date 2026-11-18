import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_SEARCH_RESULTS } from "../../testing/fake-model";
import { gatewayRequest, startSession } from "../../testing/gateway-client";
import { createTestApp, MODEL_KEY, type TestApp } from "../../testing/test-app";
import { upstreamErrors, webToolUsage } from "../db/schema";

/** 模型网关的联网搜索（#26）：DeepSeek 搜索接口的格式，转给提供方，按次数记用量。 */
describe("模型网关的联网搜索", () => {
  let t: TestApp;
  let sessionId: string;

  beforeAll(async () => {
    t = await createTestApp();
    const { browser } = await t.adminWithGitHub("octo", "octo/app");
    ({ sessionId } = await startSession(t, browser, "octo/app"));
  });
  afterAll(() => t.close());

  const search = (body: unknown, headers?: Record<string, string>) =>
    gatewayRequest(t, sessionId, "/v1/tools/search", { body, headers });
  const usage = () => t.db.select().from(webToolUsage).where(eq(webToolUsage.sessionId, sessionId));

  it("只转搜索词、条数、要不要正文和原问题；换上 key；结果只留地址、标题、摘要、正文和日期", async () => {
    const res = await search(
      {
        query: "  SeekCloud 是什么 ",
        count: 5,
        need_content: false,
        ori_question: "帮我查一下 SeekCloud",
        dsh_session_log: { secret: true },
        user_id: "anon-1",
      },
      { "x-deepseek-harness-user-id": "anon-1", "x-api-key": "session-token" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { url: "https://example.com/a", title: "第一条", snippet: "摘要一", date: "2026-11-01" },
        { url: "https://example.com/b", title: "第二条", snippet: "摘要二", date: null },
      ],
    });
    expect(JSON.stringify(FAKE_SEARCH_RESULTS)).toContain("upstream-secret-id");

    const sent = t.model.requests.at(-1);
    // 联网工具在接口地址的同一个域名下，路径是 /v1/tools/search
    expect(sent?.url).toBe("https://model.test/v1/tools/search");
    expect(sent?.body).toEqual({
      query: "SeekCloud 是什么",
      count: 5,
      need_content: false,
      ori_question: "帮我查一下 SeekCloud",
    });
    expect(sent?.headers.get("authorization")).toBe(`Bearer ${MODEL_KEY}`);
    expect(sent?.headers.get("x-api-key")).toBeNull();
    expect(sent?.headers.get("x-deepseek-harness-user-id")).toBeNull();
    expect(sent?.headers.get("x-seekcloud-session")).toBeNull();
  });

  it("搜索词为空、条数不对、need_content 不是布尔值：直接拒绝，不转发", async () => {
    const before = t.model.requests.length;
    for (const body of [
      { query: "  " },
      { query: "x", count: 0 },
      { query: "x", count: 51 },
      { query: "x", count: "5" },
      { query: "x", need_content: "yes" },
      { query: "x".repeat(2001) },
    ]) {
      expect((await search(body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await search("不是 JSON")).status).toBe(400);
    expect(t.model.requests.length).toBe(before);
  });

  it("每次搜索记一条用量（按次数）：成功的记提供方，出错的标出来", async () => {
    const before = (await usage()).length;
    await search({ query: "一次" });
    t.model.reply({ status: 500, body: "boom" });
    await search({ query: "两次" });
    const rows = (await usage()).slice(before);
    expect(rows.map((r) => ({ tool: r.tool, provider: r.provider, ok: r.ok }))).toEqual([
      { tool: "web_search", provider: "deepseek", ok: true },
      { tool: "web_search", provider: "deepseek", ok: false },
    ]);
  });

  it("上游出错：沙箱只收到我们的说明、状态码和参考号；原始报错按参考号存下", async () => {
    t.model.reply({
      status: 429,
      body: '{"error":"quota exceeded for key sk-abc123 at https://internal.example"}',
      headers: { "retry-after": "7", "x-request-id": "req_secret" },
    });
    const res = await search({ query: "限流" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("x-request-id")).toBeNull();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("sk-abc123");
    expect(body.error.message).toMatch(/^模型服务限流（429 · 参考号 \w+）$/);
    const ref = /参考号 (\w+)/.exec(body.error.message)?.[1] as string;
    const [stored] = await t.db.select().from(upstreamErrors).where(eq(upstreamErrors.ref, ref));
    expect(stored?.body).toContain("sk-abc123");
  });

  it("上游回的东西看不懂：当作上游出错", async () => {
    t.model.reply({ json: { unexpected: true } });
    const res = await search({ query: "怪" });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/参考号/);
  });
});

describe("联网搜索的准入", () => {
  it("准入不放行：回它给的说明，不转发；没填 key 时提示去设置里填", async () => {
    const t = await createTestApp({
      modelAdmission: {
        admit: async () => ({ ok: true }),
        record: async () => undefined,
        admitWebTool: async () => ({ ok: false, message: "今天的联网搜索次数用完了" }),
        recordWebTool: async () => undefined,
      },
    });
    try {
      const { browser } = await t.adminWithGitHub("octo", "octo/app");
      const { sessionId } = await startSession(t, browser, "octo/app");
      const res = await gatewayRequest(t, sessionId, "/v1/tools/search", { body: { query: "x" } });
      expect(res.status).toBe(429);
      expect((await res.json()).error.message).toBe("今天的联网搜索次数用完了");
      expect(t.model.requests.filter((r) => r.url.includes("/tools/"))).toEqual([]);
    } finally {
      await t.close();
    }

    const noKey = await createTestApp();
    try {
      const { browser } = await noKey.adminWithGitHub("octo", "octo/app");
      const { sessionId } = await startSession(noKey, browser, "octo/app");
      // 会话开着的时候管理员把 key 删了
      const deleted = await browser.request("/api/settings/model-provider/key", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
      expect(deleted.status).toBe(200);
      const res = await gatewayRequest(noKey, sessionId, "/v1/tools/search", {
        body: { query: "x" },
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error.message).toContain("设置 → 模型");
    } finally {
      await noKey.close();
    }
  });
});
