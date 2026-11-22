import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const put = (browser: TestBrowser, body: unknown) =>
  browser.request("/api/settings/ai-labels", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("设置：AI 标识的两个开关", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  const start = async (text: string) => {
    const res = await browser.post("/api/sessions", { repo: "octo/app", baseBranch: "main", text });
    expect(res.status).toBe(201);
    await t.host.idle();
    return (await res.json()) as { shortId: string };
  };

  it("默认都开；没登录不能看也不能改", async () => {
    expect(await (await browser.get("/api/settings/ai-labels")).json()).toEqual({
      signature: true,
      commitTrailer: true,
    });
    expect((await t.browser().get("/api/settings/ai-labels")).status).toBe(401);
    expect((await put(t.browser(), { signature: false, commitTrailer: false })).status).toBe(401);
  });

  it("准备沙箱时把开关带给宿主机", async () => {
    await start("第一个会话");
    expect(t.host.last("prepare_sandbox").aiLabels).toEqual({
      signature: true,
      commitTrailer: true,
    });
  });

  it("两个开关各改各的，改完记得住；沙箱还开着的会话当场收到新的值", async () => {
    const before = t.host.commands.length;
    const res = await put(browser, { signature: false, commitTrailer: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: false, commitTrailer: true });
    expect(await (await browser.get("/api/settings/ai-labels")).json()).toEqual({
      signature: false,
      commitTrailer: true,
    });
    // 第一个会话的回合已经结束（等待回复），沙箱还开着
    const sent = t.host.commands.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "set_ai_labels",
      aiLabels: { signature: false, commitTrailer: true },
    });

    // 之后新开的会话，准备沙箱时带的是新的值
    await start("第二个会话");
    expect(t.host.last("prepare_sandbox").aiLabels).toEqual({
      signature: false,
      commitTrailer: true,
    });
  });

  it("格式不对：400，原来的值不变", async () => {
    for (const body of [{ signature: "no", commitTrailer: true }, { signature: true }, {}]) {
      expect((await put(browser, body)).status).toBe(400);
    }
    expect(await (await browser.get("/api/settings/ai-labels")).json()).toEqual({
      signature: false,
      commitTrailer: true,
    });
  });
});

describe("设置：新会话默认的思考强度", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  const put = (b: TestBrowser, body: unknown) =>
    b.request("/api/settings/default-effort", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const start = async (extra: Record<string, unknown> = {}) => {
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "改一下首页",
      ...extra,
    });
    expect(res.status).toBe(201);
    await t.host.idle();
    return (await res.json()) as { shortId: string; effort: string };
  };
  const defaultEffort = async () =>
    ((await (await browser.get("/api/models")).json()) as { defaultEffort: string }).defaultEffort;

  it("没改过时是高档；没登录不能看也不能改", async () => {
    expect(await (await browser.get("/api/settings/default-effort")).json()).toEqual({
      effort: "high",
    });
    expect(await defaultEffort()).toBe("high");
    expect((await start()).effort).toBe("high");
    expect((await t.browser().get("/api/settings/default-effort")).status).toBe(401);
    expect((await put(t.browser(), { effort: "low" })).status).toBe(401);
  });

  it("改了以后：模型列表里的默认值跟着变，没指定思考强度的新会话用它；已有的会话不变", async () => {
    const before = await start();
    const res = await put(browser, { effort: "low" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ effort: "low" });
    expect(await defaultEffort()).toBe("low");

    expect((await start()).effort).toBe("low");
    // 指定了的照指定的
    expect((await start({ effort: "max" })).effort).toBe("max");
    const old = await (await browser.get(`/api/sessions/${before.shortId}`)).json();
    expect(old.effort).toBe("high");
  });

  it("格式不对：400，原来的值不变", async () => {
    for (const body of [{ effort: "extreme" }, { effort: null }, {}]) {
      expect((await put(browser, body)).status).toBe(400);
    }
    expect(await (await browser.get("/api/settings/default-effort")).json()).toEqual({
      effort: "low",
    });
  });
});

describe("设置：平台调用的模型（#140）", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    browser = await t.admin();
  });
  afterAll(() => t.close());

  const put = (b: TestBrowser, body: unknown) =>
    b.request("/api/settings/platform-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("没改过是自动（auto）；可以选模型列表里的、再改回自动；不在列表里的不行；没登录不能看也不能改", async () => {
    expect(await (await browser.get("/api/settings/platform-model")).json()).toMatchObject({
      model: "auto",
      // 自动：按 dsh 内置目录的价格挑最省的，说明现在用的是哪个、为什么
      resolved: "deepseek/deepseek-flash",
      basis: "price",
    });
    const res = await put(browser, { model: "deepseek/deepseek-v4-pro" });
    expect(res.status).toBe(200);
    expect(await (await browser.get("/api/settings/platform-model")).json()).toMatchObject({
      model: "deepseek/deepseek-v4-pro",
      resolved: "deepseek/deepseek-v4-pro",
      basis: "chosen",
    });
    // #113 之前的写法（只有模型 ID）当作 DeepSeek 官方的
    expect(await (await put(browser, { model: "deepseek-flash" })).json()).toMatchObject({
      model: "deepseek/deepseek-flash",
    });
    const bad = await put(browser, { model: "gpt-x" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("unknown_model");
    expect((await put(browser, { model: "auto" })).status).toBe(200);
    const state = (await (await browser.get("/api/settings/platform-model")).json()) as {
      model: string;
      candidates: Array<{
        ref: string;
        cost: number[];
        callCost: number;
        canSkipThinking: boolean;
      }>;
    };
    expect(state.model).toBe("auto");
    // 每个能选的模型都带价格和估出来的一次平台调用的价钱（约 2000 个输入 token、20 个输出 token）
    expect(state.candidates.map((c) => c.ref)).toEqual([
      "deepseek/deepseek-flash",
      "deepseek/deepseek-v4-pro",
    ]);
    expect(state.candidates[0]).toMatchObject({ cost: [0.3, 1.2], canSkipThinking: true });
    expect(state.candidates[0]?.callCost).toBeCloseTo((0.3 * 2000 + 1.2 * 20) / 1e6, 10);
    expect((await t.browser().get("/api/settings/platform-model")).status).toBe(401);
    expect((await put(t.browser(), { model: "auto" })).status).toBe(401);
  });
});

describe("设置：界面语言（#135）", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const putLanguage = (b: TestBrowser, body: unknown) =>
    b.request("/api/settings/language", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("没改过是跟随浏览器；改了跟着管理员存，换一台设备登录读到的也是它；不支持的语言 400；没登录不行", async () => {
    const browser = await t.admin();
    expect(await (await browser.get("/api/settings/language")).json()).toEqual({
      language: "auto",
    });
    expect((await putLanguage(browser, { language: "en" })).status).toBe(200);
    const another = await t.admin();
    expect(await (await another.get("/api/settings/language")).json()).toEqual({ language: "en" });
    expect((await putLanguage(browser, { language: "ja" })).status).toBe(400);
    expect((await t.browser().get("/api/settings/language")).status).toBe(401);
    expect((await putLanguage(t.browser(), { language: "en" })).status).toBe(401);
  });
});
