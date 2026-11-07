import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const MINUTE = 60_000;

function sendCode(browser: TestBrowser, email: string, ip = "203.0.113.1") {
  return browser.request("/api/auth/email/send-code", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email }),
  });
}

describe("频率限制", () => {
  let t: TestApp;

  // 每个用例一个新的主站，计数互不影响。
  beforeEach(async () => {
    await t?.close();
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("同一个邮箱 60 秒内只能发一次验证码", async () => {
    const browser = t.browser();
    expect((await sendCode(browser, "a@example.com")).status).toBe(204);

    const again = await sendCode(browser, "a@example.com");

    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("60");
    expect(await again.json()).toEqual({
      error: { code: "rate_limited", message: "操作过于频繁，请 60 秒后重试" },
    });
    t.clock.advance(MINUTE);
    expect((await sendCode(browser, "a@example.com")).status).toBe(204);
  });

  it("同一个邮箱一小时最多发 5 次", async () => {
    const browser = t.browser();
    for (let i = 0; i < 5; i++) {
      expect((await sendCode(browser, "a@example.com")).status).toBe(204);
      t.clock.advance(MINUTE);
    }

    expect((await sendCode(browser, "a@example.com")).status).toBe(429);
  });

  it("同一个 IP 一小时最多发 20 次，换个 IP 不受影响", async () => {
    const browser = t.browser();
    for (let i = 0; i < 20; i++) {
      expect((await sendCode(browser, `u${i}@example.com`)).status).toBe(204);
    }

    expect((await sendCode(browser, "u20@example.com")).status).toBe(429);
    expect((await sendCode(browser, "u20@example.com", "198.51.100.7")).status).toBe(204);
  });

  it("同一个 IP 一小时内填错 10 次邀请码后，暂时不能再试", async () => {
    const browser = t.browser();
    const verify = (inviteCode: string) =>
      browser.request("/api/auth/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({
          email: "new@example.com",
          code: t.lastLoginCode("new@example.com"),
          inviteCode,
          acceptTerms: true,
        }),
      });
    await sendCode(browser, "new@example.com", "203.0.113.9");
    for (let i = 0; i < 10; i++) {
      expect((await verify("ZZZZ-ZZZZ")).status).toBe(400);
    }

    const blocked = await verify(await t.createInvite());

    expect(blocked.status).toBe(429);
  });

  it("邀请码试太多次只挡带邀请码的请求：同一个 IP 的老用户照样能登录", async () => {
    const ip = "203.0.113.20";
    const browser = t.browser();
    const post = (path: string, body: unknown) =>
      browser.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      });
    await post("/api/auth/email/send-code", { email: "old@example.com" });
    await post("/api/auth/email/verify", {
      email: "old@example.com",
      code: t.lastLoginCode("old@example.com"),
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });
    t.clock.advance(MINUTE);
    await post("/api/auth/email/send-code", { email: "guesser@example.com" });
    for (let i = 0; i < 10; i++) {
      await post("/api/auth/email/verify", {
        email: "guesser@example.com",
        code: t.lastLoginCode("guesser@example.com"),
        inviteCode: "ZZZZ-ZZZZ",
        acceptTerms: true,
      });
    }
    await post("/api/auth/email/send-code", { email: "old@example.com" });

    const res = await post("/api/auth/email/verify", {
      email: "old@example.com",
      code: t.lastLoginCode("old@example.com"),
    });

    expect(res.status).toBe(200);
  });

  it("IP 只认反向代理追加的最后一个值，前面伪造的不算", async () => {
    const browser = t.browser();
    for (let i = 0; i < 20; i++) {
      await sendCode(browser, `f${i}@example.com`, `198.18.0.${i}, 203.0.113.30`);
    }

    const res = await sendCode(browser, "f20@example.com", "198.18.0.99, 203.0.113.30");

    expect(res.status).toBe(429);
  });
});
