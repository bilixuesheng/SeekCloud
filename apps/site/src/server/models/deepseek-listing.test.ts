import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_PROTOCOLS } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";
import { CATALOG, DEEPSEEK_MODELS } from "./catalog";
import { compareVersions, DeepSeekListing, decodeListing, LISTING_URL } from "./deepseek-listing";

const usable = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  api_capabilities: { anthropic_messages: {} },
  ...extra,
});

describe("DeepSeek 发布的模型列表（照 dsh 的规则读）", () => {
  it("认识的模型用列表里的名称、上下文窗口、输入类型；max_output_tokens 限住最大输出；描述留着内置的", () => {
    const [flash] = decodeListing(
      {
        data: [
          usable("deepseek-flash", {
            name: "DeepSeek V4.2 Flash",
            context_window: 2_000_000,
            max_output_tokens: 64_000,
            input_modalities: ["text"],
          }),
        ],
      },
      "0.2.2",
    );
    expect(flash).toMatchObject({
      ref: "deepseek/deepseek-flash",
      name: "DeepSeek V4.2 Flash",
      contextWindow: 2_000_000,
      maxTokens: 64_000,
      input: ["text"],
      efforts: ["off", "low", "high", "max"],
    });
  });

  it("不认识的模型要声明 min_version 而且沙箱里的 dsh 够新才给；声明读不懂的不给", () => {
    const models = decodeListing(
      {
        data: [
          usable("new-a"),
          usable("new-b", {
            client_requirements: { "deepseek-harness": { min_version: "0.2.2-rc.1" } },
          }),
          usable("new-c", {
            client_requirements: { "deepseek-harness": { min_version: "0.3.0" } },
          }),
          usable("new-d", { client_requirements: "bad" }),
          usable("deepseek-v4-pro", {
            client_requirements: { "deepseek-harness": { min_version: "9.0.0" } },
          }),
        ],
      },
      "0.2.2-rc.3",
    );
    expect(models.map((m) => m.id)).toEqual(["new-b"]);
  });

  it("没有 Messages 能力、不输出文字、输入类型都不认得、容量写错、ID 重复的跳过", () => {
    const models = decodeListing(
      {
        data: [
          { id: "deepseek-flash" },
          usable("deepseek-flash", { output_modalities: ["image"] }),
          usable("deepseek-flash", { input_modalities: ["audio"] }),
          usable("deepseek-flash", { context_window: -1 }),
          usable("deepseek-v4-pro"),
          usable("deepseek-v4-pro", { name: "重复的" }),
          null,
          { id: 3 },
        ],
      },
      "0.2.2",
    );
    // 前四个 deepseek-flash：第一个就占了 ID，后面的按重复跳过
    expect(models.map((m) => [m.id, m.name])).toEqual([["deepseek-v4-pro", "DeepSeek-V4-Pro"]]);
    expect(decodeListing({ models: [] }, "0.2.2")).toEqual([]);
    expect(decodeListing("oops", "0.2.2")).toEqual([]);
  });

  it("semver 的先后：预发布号低于同号的正式版", () => {
    expect(compareVersions("0.2.2-rc.3", "0.2.2-rc.1")).toBe(1);
    expect(compareVersions("0.2.2-rc.3", "0.2.2")).toBe(-1);
    expect(compareVersions("0.2.2", "0.2.2")).toBe(0);
    expect(compareVersions("0.2.10", "0.2.9")).toBe(1);
    expect(compareVersions("0.2.1-alpha.2", "0.2.1-alpha.10")).toBe(-1);
    expect(compareVersions("0.2.1-1", "0.2.1-alpha")).toBe(-1);
    expect(compareVersions("x", "0.2.1")).toBeUndefined();
  });
});

describe("DeepSeek 发布列表的缓存", () => {
  const setup = (replies: Array<Response | Error>) => {
    let now = 0;
    const calls: Array<{ url: string; headers: Headers }> = [];
    const listing = new DeepSeekListing({
      fetch: async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        const next = replies.shift() ?? new Error("没有更多回复");
        if (next instanceof Error) throw next;
        return next;
      },
      now: () => now,
      maxAgeMs: 1000,
      userAgent: "SeekCloud/test",
    });
    return { listing, calls, advance: (ms: number) => (now += ms) };
  };
  const list = (...ids: string[]) =>
    Response.json({
      data: ids.map((id) =>
        usable(id, { client_requirements: { "deepseek-harness": { min_version: "0.1.0" } } }),
      ),
    });

  it("第一次等列表；key 放在 x-api-key；之后到时间才在后台刷新，刷新期间先给缓存", async () => {
    const { listing, calls, advance } = setup([list("deepseek-flash", "new-one"), list("new-two")]);
    expect((await listing.models("sk-a")).map((m) => m.id)).toEqual(["deepseek-flash", "new-one"]);
    expect(calls[0]?.url).toBe(LISTING_URL);
    expect(calls[0]?.headers.get("x-api-key")).toBe("sk-a");
    // 没到时间不再去取
    expect((await listing.models("sk-a")).map((m) => m.id)).toEqual(["deepseek-flash", "new-one"]);
    expect(calls).toHaveLength(1);
    advance(1000);
    // 到时间了：这一次先给旧的，后台去取
    expect((await listing.models("sk-a")).map((m) => m.id)).toEqual(["deepseek-flash", "new-one"]);
    await new Promise((r) => setTimeout(r, 10));
    expect((await listing.models("sk-a")).map((m) => m.id)).toEqual(["new-two"]);
  });

  it("取不到、列表为空时留着上一份；一份都没有时用内置的两个；每把 key 一份", async () => {
    const { listing, advance } = setup([
      new Response("nope", { status: 401 }),
      list("only-a"),
      Response.json({ data: [] }),
    ]);
    expect(await listing.models("sk-a")).toEqual(DEEPSEEK_MODELS);
    expect((await listing.models("sk-b")).map((m) => m.id)).toEqual(["only-a"]);
    advance(1000);
    await listing.models("sk-b");
    await new Promise((r) => setTimeout(r, 10));
    expect((await listing.models("sk-b")).map((m) => m.id)).toEqual(["only-a"]);
  });
});

describe("第三方提供方的目录快照", () => {
  it("和沙箱里装的 dsh 是同一个版本（升级 dsh 时用 pnpm model-catalog 重新生成）", () => {
    const pinned = readFileSync(
      join(import.meta.dirname, "../../../../host/sandbox/dsh/VERSION"),
      "utf8",
    ).trim();
    expect(CATALOG.source.dsh).toBe(pinned);
  });

  it("只收填一个 key 就能用的：四种协议、固定的地址、有环境变量名；不收 DeepSeek（内置卡片管）", () => {
    expect(CATALOG.providers.length).toBeGreaterThan(10);
    for (const p of CATALOG.providers) {
      expect(p.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(p.env.length, p.id).toBeGreaterThan(0);
      expect(p.models.length, p.id).toBeGreaterThan(0);
      for (const [api, url] of Object.entries(p.endpoints)) {
        expect(MODEL_PROTOCOLS).toContain(api);
        expect(url).toMatch(/^https:\/\/[^{}]+$/);
      }
      for (const m of p.models) expect(Object.keys(p.endpoints)).toContain(m.api);
    }
    expect(CATALOG.providers.map((p) => p.id)).not.toContain("deepseek");
    expect(CATALOG.providers.map((p) => p.id)).toEqual(
      expect.arrayContaining(["openai", "anthropic", "google"]),
    );
  });
});
