import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, MODEL_KEY, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";
import { modelProviders, sessions } from "../db/schema";
import { configuredRouting } from "../gateway/trunk";
import { CATALOG } from "./catalog";

/** 设置的"模型"（#113）：提供方的增、改、停用、删除，key 只写不读，环境变量，/api/models，路由。 */

const send = (browser: TestBrowser, method: string, path: string, body: unknown = {}) =>
  browser.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const PROVIDERS = "/api/settings/model-providers";

interface View {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  credential: { masked: string | null; env: string[]; envDetected: string | null };
  customModels: boolean;
  models: Array<{ id: string; efforts: string[]; contextWindow: number; maxTokens: number }>;
}
interface ModelList {
  models: Array<{ id: string; provider: string; efforts: string[]; input: string[] }>;
  providers: Array<{ id: string; models: string[] }>;
  defaultModel: string | null;
}

const customBody = {
  kind: "custom",
  id: "my-gateway",
  name: "公司网关",
  api: "openai-completions",
  baseUrl: "https://gateway.example/v1",
  apiKey: "gw-0123456789abcdefghij",
  models: [
    { id: "chat-small", input: ["text"] },
    {
      id: "reasoner",
      name: "推理模型",
      contextWindow: 200_000,
      input: ["text", "image"],
      reasoningEfforts: { off: null, high: "high", max: "xhigh" },
    },
  ],
};

describe("模型提供方的设置", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp({ env: { MOONSHOT_API_KEY: "ms-from-env-0123456789" } });
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  const list = async () =>
    ((await (await browser.get(PROVIDERS)).json()) as { providers: View[] }).providers;
  const models = async () => (await (await browser.get("/api/models")).json()) as ModelList;

  it("内置的 DeepSeek 总在；key 在库里是密文，接口只给脱敏预览", async () => {
    const [deepseek] = await list();
    expect(deepseek).toMatchObject({
      id: "deepseek",
      kind: "deepseek",
      enabled: true,
      credential: { masked: `sk-test-${"•".repeat(12)}cdef`, env: ["DEEPSEEK_API_KEY"] },
      customModels: false,
    });
    expect(deepseek?.models.map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    const [row] = await t.deps.db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.slug, "deepseek"));
    expect(row?.apiKey).toBeTruthy();
    expect(row?.apiKey).not.toContain(MODEL_KEY);
    expect(JSON.stringify(await list())).not.toContain(MODEL_KEY);
  });

  it("目录：列出填一个 key 就能用的提供方，已经加过的标出来", async () => {
    const { providers } = (await (await browser.get(`${PROVIDERS}/catalog`)).json()) as {
      providers: Array<{ id: string; env: string[]; added: boolean; models: number }>;
    };
    expect(providers.map((p) => p.id)).toEqual(CATALOG.providers.map((p) => p.id));
    expect(providers.find((p) => p.id === "openai")).toMatchObject({
      env: ["OPENAI_API_KEY"],
      added: false,
    });
  });

  it("从目录添加：不填 key 时读目录列出的环境变量（只看有没有）；模型列表由目录给", async () => {
    const res = await browser.post(PROVIDERS, { kind: "catalog", id: "moonshotai" });
    expect(res.status).toBe(201);
    const view = (await res.json()) as View;
    expect(view).toMatchObject({
      id: "moonshotai",
      kind: "catalog",
      credential: { masked: null, env: ["MOONSHOT_API_KEY"], envDetected: "MOONSHOT_API_KEY" },
    });
    const catalogModels = CATALOG.providers.find((p) => p.id === "moonshotai")?.models ?? [];
    expect(view.models.map((m) => m.id)).toEqual(catalogModels.map((m) => m.id));
    const listed = await models();
    expect(listed.providers.map((p) => p.id)).toEqual(["deepseek", "moonshotai"]);
    expect(listed.models.filter((m) => m.provider === "moonshotai")).toHaveLength(
      catalogModels.length,
    );
    // 再加一次：已经有了
    expect((await browser.post(PROVIDERS, { kind: "catalog", id: "moonshotai" })).status).toBe(409);
    expect((await browser.post(PROVIDERS, { kind: "catalog", id: "no-such" })).status).toBe(404);
  });

  it("没有 key 也没有环境变量的提供方：设置里有，模型选择器里没有", async () => {
    expect((await browser.post(PROVIDERS, { kind: "catalog", id: "groq" })).status).toBe(201);
    const groq = (await list()).find((p) => p.id === "groq");
    expect(groq?.credential).toMatchObject({
      masked: null,
      envDetected: null,
      env: ["GROQ_API_KEY"],
    });
    expect((await models()).providers.map((p) => p.id)).not.toContain("groq");
  });

  it("自定义接口：模型、推理等级、默认值；目录里的 ID 和内置的 ID 不能用；格式不对 400", async () => {
    const res = await browser.post(PROVIDERS, customBody);
    expect(res.status).toBe(201);
    const view = (await res.json()) as View;
    expect(view.models).toEqual([
      expect.objectContaining({
        id: "chat-small",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        efforts: [],
      }),
      expect.objectContaining({
        id: "reasoner",
        contextWindow: 200_000,
        efforts: ["off", "high", "max"],
      }),
    ]);
    const listed = (await models()).models.filter((m) => m.provider === "my-gateway");
    expect(listed.map((m) => [m.id, m.efforts, m.input])).toEqual([
      ["my-gateway/chat-small", [], ["text"]],
      ["my-gateway/reasoner", ["off", "high", "max"], ["text", "image"]],
    ]);

    for (const id of ["openai", "deepseek", "my-gateway"]) {
      expect((await browser.post(PROVIDERS, { ...customBody, id })).status, id).toBe(409);
    }
    const bad = [
      { ...customBody, id: "Bad_ID" },
      { ...customBody, id: "x2", models: [] },
      { ...customBody, id: "x3", models: [{ id: "a", input: [] }] },
      {
        ...customBody,
        id: "x4",
        models: [
          { id: "a", input: ["text"] },
          { id: "a", input: ["text"] },
        ],
      },
      {
        ...customBody,
        id: "x5",
        models: [{ id: "a", input: ["text"], reasoningEfforts: { off: null } }],
      },
      {
        ...customBody,
        id: "x6",
        models: [{ id: "a", input: ["text"], reasoningEfforts: { high: null } }],
      },
      { ...customBody, id: "x7", baseUrl: "ftp://example.com" },
      { ...customBody, id: "x8", apiKey: "has space" },
    ];
    for (const body of bad) {
      expect((await browser.post(PROVIDERS, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("改名、换 key（下一次请求就用新的）、删 key 退回环境变量、停用以后模型选择器里没有了", async () => {
    const renamed = (await (
      await send(browser, "PATCH", `${PROVIDERS}/my-gateway`, { name: "新名字" })
    ).json()) as View;
    expect(renamed.name).toBe("新名字");

    const routing = configuredRouting(t.deps);
    const headersOf = async () =>
      (
        await routing.route("my-gateway/reasoner", {
          purpose: "agent",
          userId: null,
          sessionId: null,
          turnId: null,
          model: "my-gateway/reasoner",
        })
      )[0]?.headers("/chat/completions", new Headers());
    expect((await headersOf())?.get("authorization")).toBe("Bearer gw-0123456789abcdefghij");
    await send(browser, "PATCH", `${PROVIDERS}/my-gateway`, { apiKey: "gw-new-key-0123456789" });
    expect((await headersOf())?.get("authorization")).toBe("Bearer gw-new-key-0123456789");

    // 删 key：自定义接口填了环境变量名就读它（这里没有这个变量：没有可用的）
    await send(browser, "PATCH", `${PROVIDERS}/my-gateway`, {
      apiKey: null,
      apiKeyEnv: "GATEWAY_KEY",
    });
    expect(await headersOf()).toBeUndefined();
    await send(browser, "PATCH", `${PROVIDERS}/my-gateway`, { apiKey: "gw-again-0123456789" });

    await send(browser, "PATCH", `${PROVIDERS}/moonshotai`, { enabled: false });
    expect((await models()).providers.map((p) => p.id)).not.toContain("moonshotai");
    await send(browser, "PATCH", `${PROVIDERS}/moonshotai`, { enabled: true });
    expect((await models()).providers.map((p) => p.id)).toContain("moonshotai");
  });

  it("目录里的提供方改了模型列表就用自己的，“恢复默认模型”退回目录；自定义接口不能恢复默认", async () => {
    const own = (await (
      await send(browser, "PATCH", `${PROVIDERS}/moonshotai`, {
        models: [{ id: "kimi-only", input: ["text"] }],
      })
    ).json()) as View;
    expect(own.customModels).toBe(true);
    expect(own.models.map((m) => m.id)).toEqual(["kimi-only"]);
    const reset = (await (
      await send(browser, "PATCH", `${PROVIDERS}/moonshotai`, { resetModels: true })
    ).json()) as View;
    expect(reset.customModels).toBe(false);
    expect(reset.models.length).toBeGreaterThan(1);
    expect(
      (await send(browser, "PATCH", `${PROVIDERS}/my-gateway`, { resetModels: true })).status,
    ).toBe(400);
    expect((await send(browser, "PATCH", `${PROVIDERS}/nobody`, { name: "x" })).status).toBe(404);
  });

  it("调整先后：模型选择器跟着变", async () => {
    await send(browser, "PUT", `${PROVIDERS}/order`, { order: ["my-gateway", "deepseek"] });
    expect((await list()).map((p) => p.id)).toEqual([
      "my-gateway",
      "deepseek",
      "moonshotai",
      "groq",
    ]);
    expect((await models()).providers.map((p) => p.id)).toEqual([
      "my-gateway",
      "deepseek",
      "moonshotai",
    ]);
  });

  it("用自定义接口的模型发起会话：没声明推理等级的记成关闭；宿主机拿到提供方和模型", async () => {
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "看看",
      model: "my-gateway/chat-small",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ model: "my-gateway/chat-small", effort: "off" });
    await t.host.idle();
    expect(t.host.last("start_turn")).toMatchObject({
      provider: "my-gateway",
      model: "chat-small",
      effort: "off",
    });
    // 不支持的档位不行
    const bad = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "看看",
      model: "my-gateway/chat-small",
      effort: "high",
    });
    expect(bad.status).toBe(400);
  });

  it("删除：先看受影响的会话数；删了以后会话保留自己的模型，发消息时提示换一个；DeepSeek 不能删", async () => {
    const usage = (await (await browser.get(`${PROVIDERS}/my-gateway/sessions`)).json()) as {
      sessions: number;
    };
    expect(usage.sessions).toBe(1);
    expect((await send(browser, "DELETE", `${PROVIDERS}/my-gateway`)).status).toBe(200);
    expect((await list()).map((p) => p.id)).not.toContain("my-gateway");
    const [session] = await t.deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.model, "my-gateway/chat-small"));
    expect(session).toBeTruthy();
    const shortId = session?.shortId as string;
    const reply = await browser.post(`/api/sessions/${shortId}/messages`, { text: "继续" });
    expect(reply.status).toBe(409);
    expect((await reply.json()).error.code).toBe("model_gone");
    // 换一个模型就能接着发
    const switched = await browser.post(`/api/sessions/${shortId}/messages`, {
      text: "继续",
      model: "deepseek/deepseek-flash",
    });
    expect(switched.status).toBe(201);
    expect(await switched.json()).toMatchObject({
      model: "deepseek/deepseek-flash",
      effort: "high",
    });

    const builtin = await send(browser, "DELETE", `${PROVIDERS}/deepseek`);
    expect(builtin.status).toBe(409);
    expect((await builtin.json()).error.code).toBe("provider_builtin");
  });

  it("新会话默认的模型：选过的还能用就用它，不能用了退回第一个能用的", async () => {
    expect((await models()).defaultModel).toBe("deepseek/deepseek-flash");
    const moonshot = (await models()).models.find((m) => m.provider === "moonshotai")?.id as string;
    expect(
      (await send(browser, "PUT", "/api/settings/default-model", { model: moonshot })).status,
    ).toBe(200);
    expect((await models()).defaultModel).toBe(moonshot);
    expect(
      (await send(browser, "PUT", "/api/settings/default-model", { model: "nobody/x" })).status,
    ).toBe(400);
    await send(browser, "PATCH", `${PROVIDERS}/moonshotai`, { enabled: false });
    expect((await models()).defaultModel).toBe("deepseek/deepseek-flash");
  });

  it("没登录不能看也不能改", async () => {
    const anon = t.browser();
    expect((await anon.get(PROVIDERS)).status).toBe(401);
    expect((await anon.post(PROVIDERS, customBody)).status).toBe(401);
  });
});

describe("接口地址的提示", () => {
  it("不是 HTTPS 的提示明文，解析到内网的提示在内网（不拦）", async () => {
    const t = await createTestApp({
      outboundNetwork: {
        resolve: async (host) => [
          { address: host === "llm.internal" ? "10.0.0.5" : "203.0.113.9", family: 4 },
        ],
        allowAddress: (a) => !a.startsWith("10."),
      },
    });
    try {
      const { browser } = await t.adminWithGitHub("octo", "octo/app");
      const check = async (url: string) =>
        (await (await browser.post(`${PROVIDERS}/check-url`, { url })).json()) as {
          plaintext: boolean;
          internal: boolean;
        };
      expect(await check("https://api.example.com/v1")).toEqual({
        plaintext: false,
        internal: false,
      });
      expect(await check("http://llm.internal:8000/v1")).toEqual({
        plaintext: true,
        internal: true,
      });
      expect((await browser.post(`${PROVIDERS}/check-url`, { url: "not a url" })).status).toBe(400);
    } finally {
      await t.close();
    }
  });
});

describe("下游不让改提供方", () => {
  it("设置的规则说 model_providers 不能改：增、改、删、排序都回 403；看照样能看", async () => {
    const t = await createTestApp({
      settingsPolicy: {
        defaultValue: (key) =>
          (
            ({
              ai_labels: { signature: true, commitTrailer: true },
              default_effort: "high",
              host_offline_grace: 120,
              platform_model: "auto",
              default_model: "",
              model_providers: null,
            }) as Record<string, unknown>
          )[key] as never,
        canWrite: (key) => key !== "model_providers",
      },
    });
    try {
      const { browser } = await t.adminWithGitHub("octo", "octo/app");
      expect((await browser.get(PROVIDERS)).status).toBe(200);
      expect((await browser.post(PROVIDERS, customBody)).status).toBe(403);
      expect((await send(browser, "PATCH", `${PROVIDERS}/deepseek`, { apiKey: null })).status).toBe(
        403,
      );
      expect((await send(browser, "DELETE", `${PROVIDERS}/deepseek`)).status).toBe(403);
      expect((await send(browser, "PUT", `${PROVIDERS}/order`, { order: [] })).status).toBe(403);
    } finally {
      await t.close();
    }
  });
});

describe("路由：认证头按协议放，地址按提供方", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { GEMINI_API_KEY: "AIza-env-0123456789" } });
    const { browser } = await t.adminWithGitHub("octo", "octo/app");
    for (const [id, api] of [
      ["a-openai", "openai-responses"],
      ["a-anthropic", "anthropic-messages"],
    ] as const) {
      await browser.post(PROVIDERS, {
        kind: "custom",
        id,
        api,
        baseUrl: `https://${id}.example/v1/`,
        apiKey: `${id}-key-0123456789`,
        models: [{ id: "m", input: ["text"] }],
      });
    }
    await browser.post(PROVIDERS, { kind: "catalog", id: "google" });
  });
  afterAll(() => t.close());

  const target = async (ref: string) =>
    (
      await configuredRouting(t.deps).route(ref, {
        purpose: "agent",
        userId: null,
        sessionId: null,
        turnId: null,
        model: ref,
      })
    )[0];

  it("OpenAI 系 Authorization: Bearer，Anthropic x-api-key（带 anthropic-version），Gemini x-goog-api-key（环境变量）", async () => {
    const openai = await target("a-openai/m");
    expect(openai?.protocol).toBe("openai-responses");
    expect(openai?.url("/responses")).toBe("https://a-openai.example/v1/responses");
    expect(openai?.headers("/responses", new Headers({ cookie: "x" })).get("authorization")).toBe(
      "Bearer a-openai-key-0123456789",
    );
    const anthropic = (await target("a-anthropic/m"))?.headers("/messages", new Headers());
    expect(anthropic?.get("x-api-key")).toBe("a-anthropic-key-0123456789");
    expect(anthropic?.get("anthropic-version")).toBeTruthy();
    expect(anthropic?.get("authorization")).toBeNull();
    const geminiModel = CATALOG.providers.find((p) => p.id === "google")?.models[0]?.id as string;
    const gemini = await target(`google/${geminiModel}`);
    expect(gemini?.protocol).toBe("google-generative-ai");
    expect(gemini?.url("/models")).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(gemini?.headers("/models", new Headers()).get("x-goog-api-key")).toBe(
      "AIza-env-0123456789",
    );
  });

  it("不在列表里的模型、不存在的提供方：没有可用的", async () => {
    expect(await target("a-openai/not-listed")).toBeUndefined();
    expect(await target("nobody/m")).toBeUndefined();
  });
});

describe("DeepSeek 的模型跟着它发布的列表", () => {
  it("填了 key、用官方地址：/api/models 里有发布的新模型，设置卡片上照旧是内置的两个；请求带 x-api-key", async () => {
    const t = await createTestApp({ deepseekListing: {} });
    try {
      const { browser } = await t.adminWithGitHub("octo", "octo/app");
      // 测试里 DeepSeek 默认指向假地址：改回官方的默认地址，才去取发布的列表
      await send(browser, "PATCH", `${PROVIDERS}/deepseek`, { baseUrl: null });
      t.model.reply({
        json: {
          data: [
            { id: "deepseek-flash", api_capabilities: { anthropic_messages: {} } },
            {
              id: "deepseek-v5",
              name: "DeepSeek-V5",
              api_capabilities: { anthropic_messages: {} },
              client_requirements: { "deepseek-harness": { min_version: "0.2.0" } },
            },
          ],
        },
      });
      const listed = (await (await browser.get("/api/models")).json()) as ModelList;
      expect(listed.models.map((m) => m.id)).toEqual([
        "deepseek/deepseek-flash",
        "deepseek/deepseek-v5",
      ]);
      const request = t.model.requests.at(-1);
      expect(request?.url).toBe("https://api.deepseek.com/models");
      expect(request?.headers.get("x-api-key")).toBe(MODEL_KEY);
      const providers = ((await (await browser.get(PROVIDERS)).json()) as { providers: View[] })
        .providers;
      expect(providers[0]?.models.map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
      // 列表里的新模型能用来发起会话
      const res = await browser.post("/api/sessions", {
        repo: "octo/app",
        baseBranch: "main",
        text: "看看",
        model: "deepseek/deepseek-v5",
      });
      expect(res.status).toBe(201);
    } finally {
      await t.close();
    }
  });
});

describe("平台调用的模型", () => {
  it("自动：能用的模型里输入加输出最便宜的；选了的还能用就用它，不能用了退回自动", async () => {
    const t = await createTestApp({ env: { GROQ_API_KEY: "gsk-env-0123456789" } });
    try {
      const { browser } = await t.adminWithGitHub("octo", "octo/app");
      await browser.post(PROVIDERS, { kind: "catalog", id: "groq" });
      const available = (await t.deps.models?.available()) ?? [];
      const all = available.flatMap((p) => p.models).filter((m) => m.cost);
      const cheapest = [...all].sort(
        (a, b) => (a.cost?.[0] ?? 0) + (a.cost?.[1] ?? 0) - ((b.cost?.[0] ?? 0) + (b.cost?.[1] ?? 0)),
      )[0];
      const userId = (await t.deps.db.select().from(sessions).limit(1))[0]?.userId ?? "x";
      expect((await t.deps.models?.platformModel(userId))?.ref).toBe(cheapest?.ref);
      await send(browser, "PUT", "/api/settings/platform-model", { model: "deepseek/deepseek-v4-pro" });
      expect((await t.deps.models?.platformModel(userId))?.ref).toBe("deepseek/deepseek-v4-pro");
      await send(browser, "PATCH", `${PROVIDERS}/deepseek`, { enabled: false });
      expect((await t.deps.models?.platformModel(userId))?.provider).toBe("groq");
    } finally {
      await t.close();
    }
  });
});
