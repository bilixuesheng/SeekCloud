import { describe, expect, it } from "vitest";
import { turnstile } from "./human-check";

/** 假的 Cloudflare：记下收到的表单，按给定的方式回复。 */
function fakeCloudflare(reply: () => Response | Promise<Response>) {
  const forms: URLSearchParams[] = [];
  const fetch = async (_url: unknown, init?: RequestInit) => {
    forms.push(new URLSearchParams(init?.body as URLSearchParams));
    return reply();
  };
  return { fetch: fetch as typeof globalThis.fetch, forms };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const check = (fetch: typeof globalThis.fetch, timeoutMs?: number) =>
  turnstile({ siteKey: "site", secretKey: "secret", fetch, timeoutMs });

describe("Cloudflare Turnstile", () => {
  it("把令牌、密钥和客户端 IP 发给 Cloudflare；成功且操作对得上才算通过", async () => {
    const cf = fakeCloudflare(() => json({ success: true, action: "signup" }));

    const result = await check(cf.fetch).verify("tok", { action: "signup", ip: "1.2.3.4" });

    expect(result).toBe("passed");
    expect(Object.fromEntries(cf.forms[0] as URLSearchParams)).toEqual({
      secret: "secret",
      response: "tok",
      remoteip: "1.2.3.4",
    });
  });

  it.each([
    ["Cloudflare 说令牌无效", { success: false, "error-codes": ["invalid-input-response"] }],
    ["令牌用过了或过期了", { success: false, "error-codes": ["timeout-or-duplicate"] }],
    ["令牌是为别的操作拿的", { success: true, action: "send_code" }],
    ["没有操作", { success: true }],
  ])("%s：不通过", async (_name, body) => {
    const cf = fakeCloudflare(() => json(body));
    expect(await check(cf.fetch).verify("tok", { action: "signup", ip: "1.2.3.4" })).toBe("failed");
  });

  it("Cloudflare 的测试密钥不带操作，也算通过（只在开发时用）", async () => {
    const cf = fakeCloudflare(() =>
      json({ success: true, metadata: { result_with_testing_key: true } }),
    );
    expect(await check(cf.fetch).verify("tok", { action: "signup", ip: "1.2.3.4" })).toBe("passed");
  });

  it("没带令牌：直接不通过，不去问 Cloudflare", async () => {
    const cf = fakeCloudflare(() => json({ success: true, action: "signup" }));
    expect(await check(cf.fetch).verify(undefined, { action: "signup", ip: "1.2.3.4" })).toBe(
      "failed",
    );
    expect(cf.forms).toHaveLength(0);
  });

  it("不知道客户端 IP 时不带 remoteip", async () => {
    const cf = fakeCloudflare(() => json({ success: true, action: "signup" }));
    await check(cf.fetch).verify("tok", { action: "signup", ip: "unknown" });
    expect(cf.forms[0]?.has("remoteip")).toBe(false);
  });

  it.each([
    ["连不上", () => Promise.reject(new TypeError("fetch failed"))],
    ["返回 5xx", () => json({}, 502)],
    ["Cloudflare 内部出错", () => json({ success: false, "error-codes": ["internal-error"] })],
    [
      "我们的密钥配错了（不能因此把所有人挡在外面）",
      () => json({ success: false, "error-codes": ["invalid-input-secret"] }),
    ],
    ["回的不是 JSON", () => new Response("<html>", { status: 200 })],
  ])("%s：算连不上（unavailable）", async (_name, reply) => {
    const cf = fakeCloudflare(reply as () => Promise<Response>);
    expect(await check(cf.fetch).verify("tok", { action: "signup", ip: "1.2.3.4" })).toBe(
      "unavailable",
    );
  });

  it("Cloudflare 一直不回：超时以后算连不上", async () => {
    const hang: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    expect(await check(hang, 50).verify("tok", { action: "signup", ip: "1.2.3.4" })).toBe(
      "unavailable",
    );
  });
});
