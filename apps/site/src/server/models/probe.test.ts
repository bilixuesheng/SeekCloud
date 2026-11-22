import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, MODEL_KEY, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";
import { CATALOG } from "./catalog";
import { decodeModelList } from "./probe";

/** "获取可用模型"（#113，照 dsh）：data 数组、models 数组或对象；401、空列表、格式不对；密钥打码；什么都不存。 */

const PROBE = "/api/settings/model-providers/probe";

describe("读端点回的模型列表", () => {
  it("OpenAI 兼容的 data 数组：ID、名称、上下文窗口", () => {
    expect(
      decodeModelList({
        data: [
          { id: "gpt-a", object: "model" },
          { id: "b", name: "模型 B", context_length: 128_000 },
          { id: "gpt-a" },
          { object: "model" },
        ],
      }),
    ).toEqual([{ id: "gpt-a" }, { id: "b", name: "模型 B", contextWindow: 128_000 }]);
  });

  it("Anthropic 的 display_name；Gemini 的 models 数组（去掉 models/ 前缀，不能生成文字的不要）", () => {
    expect(decodeModelList({ data: [{ id: "claude-x", display_name: "Claude X" }] })).toEqual([
      { id: "claude-x", name: "Claude X" },
    ]);
    expect(
      decodeModelList({
        models: [
          {
            name: "models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 65_536,
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      }),
    ).toEqual([
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_048_576, maxTokens: 65_536 },
    ]);
  });

  it("models 是对象时按键取；空列表是空的；两个都没有、不是对象时读不懂", () => {
    expect(decodeModelList({ models: { "m-1": {}, "m-2": { name: "第二个" } } })).toEqual([
      { id: "m-1" },
      { id: "m-2", name: "第二个" },
    ]);
    expect(decodeModelList({ data: [] })).toEqual([]);
    expect(decodeModelList({ list: [] })).toBeUndefined();
    expect(decodeModelList("oops")).toBeUndefined();
  });
});

describe("获取可用模型的接口", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  it("用表单里的地址、协议、key 去问；什么都不存", async () => {
    t.model.reply({ json: { data: [{ id: "m-a" }, { id: "m-b" }] } });
    const res = await browser.post(PROBE, {
      api: "openai-completions",
      baseUrl: "https://gw.example/v1/",
      apiKey: "gw-form-key-0123456789",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [{ id: "m-a" }, { id: "m-b" }] });
    const req = t.model.requests.at(-1);
    expect(req?.url).toBe("https://gw.example/v1/models");
    expect(req?.method).toBe("GET");
    expect(req?.headers.get("authorization")).toBe("Bearer gw-form-key-0123456789");
    const { providers } = await (await browser.get("/api/settings/model-providers")).json();
    expect(providers).toHaveLength(1);
  });

  it("Anthropic 问 /v1/models（x-api-key）；Gemini 问 /models（x-goog-api-key）", async () => {
    t.model.reply({ json: { data: [] } });
    await browser.post(PROBE, {
      api: "anthropic-messages",
      baseUrl: "https://a.example",
      apiKey: "a-key-0123456789",
    });
    expect(t.model.requests.at(-1)?.url).toBe("https://a.example/v1/models");
    expect(t.model.requests.at(-1)?.headers.get("x-api-key")).toBe("a-key-0123456789");
    t.model.reply({ json: { models: [] } });
    await browser.post(PROBE, {
      api: "google-generative-ai",
      baseUrl: "https://g.example/v1beta",
      apiKey: "g-key-0123456789",
    });
    expect(t.model.requests.at(-1)?.url).toBe("https://g.example/v1beta/models?pageSize=1000");
    expect(t.model.requests.at(-1)?.headers.get("x-goog-api-key")).toBe("g-key-0123456789");
  });

  it("已保存的提供方：表单里没填的用保存的 key；DeepSeek 问域名根下的 /models", async () => {
    t.model.reply({ json: { data: [{ id: "deepseek-flash" }] } });
    const res = await browser.post(PROBE, { id: "deepseek" });
    expect(await res.json()).toEqual({ models: [{ id: "deepseek-flash" }] });
    expect(t.model.requests.at(-1)?.url).toBe("https://model.test/models");
    expect(t.model.requests.at(-1)?.headers.get("x-api-key")).toBe(MODEL_KEY);
  });

  it("目录里的提供方由目录作答，不发请求", async () => {
    await browser.post("/api/settings/model-providers", { kind: "catalog", id: "groq" });
    const before = t.model.requests.length;
    const res = await browser.post(PROBE, { id: "groq" });
    const { models } = (await res.json()) as { models: Array<{ id: string }> };
    expect(models.map((m) => m.id)).toEqual(
      CATALOG.providers.find((p) => p.id === "groq")?.models.map((m) => m.id),
    );
    expect(t.model.requests.length).toBe(before);
  });

  it("401：说明里有状态码和提示，key 打了码；格式不对：提示手动填；重定向不跟", async () => {
    t.model.reply({ status: 401, body: '{"error":"invalid key gw-form-key-0123456789"}' });
    const denied = await browser.post(PROBE, {
      api: "openai-completions",
      baseUrl: "https://gw.example/v1",
      apiKey: "gw-form-key-0123456789",
    });
    expect(denied.status).toBe(400);
    const { error } = (await denied.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("probe_failed");
    expect(error.message).toContain("401");
    expect(error.message).toContain("请检查 API key");
    expect(error.message).not.toContain("gw-form-key-0123456789");

    t.model.reply({ json: { list: [] } });
    const weird = await browser.post(PROBE, {
      api: "openai-completions",
      baseUrl: "https://gw.example/v1",
    });
    expect(((await weird.json()) as { error: { message: string } }).error.message).toContain(
      "手动填写",
    );

    t.model.reply({ status: 301, body: "", headers: { location: "https://other.example/" } });
    const moved = await browser.post(PROBE, {
      api: "openai-completions",
      baseUrl: "https://gw.example/v1",
    });
    expect(((await moved.json()) as { error: { message: string } }).error.message).toContain(
      "重定向",
    );
  });

  it("认得出来的模型带上 dsh 内置目录里的资料（上下文窗口、思考档位、价格），认不出来的不带", async () => {
    t.model.reply({
      json: {
        data: [{ id: "anthropic/claude-sonnet-4.5", context_length: 1_000_000 }, { id: "m-a" }],
      },
    });
    const res = await browser.post(PROBE, {
      api: "openai-completions",
      baseUrl: "https://gw.example/v1",
    });
    const { models } = (await res.json()) as {
      models: Array<{ id: string; contextWindow?: number; known?: Record<string, unknown> }>;
    };
    // 端点自己报的上下文窗口照样带着（以它为准），目录的资料另放在 known 里
    expect(models[0]).toMatchObject({
      id: "anthropic/claude-sonnet-4.5",
      contextWindow: 1_000_000,
      known: { id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000 },
    });
    expect(models[1]).toEqual({ id: "m-a" });
  });

  it("搜内置目录：全部的（去重）或者一个提供方的；没登录不能搜", async () => {
    const all = (await (
      await browser.get("/api/settings/model-providers/known-models?q=gpt-5.1")
    ).json()) as { models: Array<{ id: string; provider: string; wire?: unknown }> };
    expect(all.models[0]).toMatchObject({
      id: "gpt-5.1",
      provider: "openai",
      wire: { off: "none" },
    });
    const groq = (await (
      await browser.get("/api/settings/model-providers/known-models?provider=groq&limit=500")
    ).json()) as { models: Array<{ provider: string }> };
    expect(groq.models.length).toBe(CATALOG.providers.find((p) => p.id === "groq")?.models.length);
    expect((await t.browser().get("/api/settings/model-providers/known-models?q=gpt")).status).toBe(
      401,
    );
  });

  it("缺协议、缺地址、没有这个提供方", async () => {
    expect((await browser.post(PROBE, { baseUrl: "https://x.example" })).status).toBe(400);
    expect((await browser.post(PROBE, { api: "openai-completions" })).status).toBe(400);
    expect((await browser.post(PROBE, { id: "nobody" })).status).toBe(404);
  });
});
