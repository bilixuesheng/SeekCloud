import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function login(browser: TestBrowser, password: string, ip = "203.0.113.1") {
  return browser.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password }),
  });
}

describe("频率限制：输错密码", () => {
  let t: TestApp;

  // 每个用例一个新的主站，计数互不影响。
  beforeEach(async () => {
    await t?.close();
    t = await createTestApp();
    await t.admin();
  });
  afterAll(() => t.close());

  it("同一个 IP 一小时内输错 10 次就暂停：正确的密码也要等，一小时后恢复", async () => {
    const browser = t.browser();
    for (let i = 0; i < 10; i++) {
      expect((await login(browser, "wrong-password")).status).toBe(400);
      t.clock.advance(MINUTE);
    }

    const blocked = await login(browser, t.adminPassword);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("3000");
    expect(await blocked.json()).toEqual({
      error: { code: "rate_limited", message: "操作过于频繁，请 3000 秒后重试" },
    });
    t.clock.advance(50 * MINUTE);
    expect((await login(browser, t.adminPassword)).status).toBe(204);
  });

  it("登录成功不算次数", async () => {
    const browser = t.browser();
    for (let i = 0; i < 9; i++) await login(browser, "wrong-password");
    for (let i = 0; i < 5; i++) expect((await login(browser, t.adminPassword)).status).toBe(204);

    expect((await login(browser, "wrong-password")).status).toBe(400);
    expect((await login(browser, t.adminPassword)).status).toBe(429);
  });

  it("换个 IP 不受影响", async () => {
    const browser = t.browser();
    for (let i = 0; i < 10; i++) await login(browser, "wrong-password");

    expect((await login(browser, t.adminPassword)).status).toBe(429);
    expect((await login(browser, t.adminPassword, "198.51.100.7")).status).toBe(204);
  });

  it("IP 只认反向代理追加的最后一个值，前面伪造的不算", async () => {
    const browser = t.browser();
    for (let i = 0; i < 10; i++) {
      await login(browser, "wrong-password", `198.18.0.${i}, 203.0.113.30`);
    }

    const res = await login(browser, t.adminPassword, "198.18.0.99, 203.0.113.30");

    expect(res.status).toBe(429);
  });

  it("修改密码时输错当前密码，和登录算在一起", async () => {
    const browser = await t.admin();
    const change = (currentPassword: string) =>
      browser.request("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.40" },
        body: JSON.stringify({ currentPassword, newPassword: "new-password" }),
      });
    for (let i = 0; i < 5; i++) expect((await change("wrong-password")).status).toBe(400);
    for (let i = 0; i < 5; i++) await login(t.browser(), "wrong-password", "203.0.113.40");

    expect((await change(t.adminPassword)).status).toBe(429);
    expect((await login(t.browser(), t.adminPassword, "203.0.113.40")).status).toBe(429);
    t.clock.advance(HOUR);
    expect((await change(t.adminPassword)).status).toBe(204);
  });
});
