import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";

describe("浏览器这边的保险和请求体上限", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await t.admin();
  });
  afterAll(() => t.close());

  it("每个响应都带内容安全策略，不允许被别的网站嵌进框架；不发 HSTS", async () => {
    const res = await t.request("/api/health");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    // 脚本只能来自本站：没有 unsafe-inline、unsafe-eval，也没有别的来源
    expect(/script-src ([^;]*)/.exec(csp)?.[1]).toBe("'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    // 要不要强制 HTTPS 由前面的反向代理定
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("请求体超过 1 MB：413，不用登录就能调的接口也一样", async () => {
    const res = await t.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x".repeat(1024 * 1024 + 1) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: { code: "body_too_large", message: "请求内容过大" },
    });
  });

  it("webhook 的上限是 25 MB（GitHub 自己的上限）：1 MB 多的照常验签", async () => {
    const body = JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) });
    const res = await t.request("/api/github/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=bad" },
      body,
    });
    // 没被请求体上限挡住，走到了验签这一步
    expect(res.status).toBe(401);
  });
});

describe("输错密码的次数：IPv6 按 /64 算一个来源", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await t.admin();
  });
  afterAll(() => t.close());

  const login = (ip: string, password: string) =>
    t.browser().request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ password }),
    });

  it("同一个 /64 里换着地址试，加起来也只有 10 次；别的 /64 不受影响", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await login(`2001:db8:1:2::${(i + 1).toString(16)}`, "wrong-password")).status).toBe(
        400,
      );
    }
    expect((await login("2001:db8:1:2:ffff::1", t.adminPassword)).status).toBe(429);
    expect((await login("2001:db8:1:3::1", t.adminPassword)).status).toBe(204);
  });
});
