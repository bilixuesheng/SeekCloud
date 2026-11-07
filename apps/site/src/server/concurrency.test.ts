import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";

// 同时到达的请求不能绕过限制。

describe("并发：验证码", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("同时猜很多次验证码，也只算最多 5 次，之后正确的码也不能用", async () => {
    const browser = t.browser();
    await browser.post("/api/auth/email/send-code", { email: "victim@example.com" });
    const code = t.lastLoginCode("victim@example.com");
    const guesses = Array.from({ length: 40 }, (_, i) => String(i).padStart(6, "0")).filter(
      (g) => g !== code,
    );

    await Promise.all(
      guesses.map((guess) =>
        t.browser().post("/api/auth/email/verify", { email: "victim@example.com", code: guess }),
      ),
    );
    const res = await browser.post("/api/auth/email/verify", {
      email: "victim@example.com",
      code,
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });

    expect(res.status).toBe(400);
  });

  it("同一个邮箱同时请求 5 次验证码，只发出 1 封", async () => {
    const before = t.mailer.sent.length;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        t.browser().post("/api/auth/email/send-code", { email: "rush@example.com" }),
      ),
    );

    expect(t.mailer.sent.length - before).toBe(1);
  });
});

describe("并发：内测席位", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ seatLimit: 1 });
  });
  afterAll(() => t.close());

  it("只剩 1 个席位时，4 个人同时注册只有 1 个成功", async () => {
    const people = await Promise.all(
      ["a", "b", "c", "d"].map(async (name) => {
        const browser = t.browser();
        const email = `${name}@example.com`;
        await browser.post("/api/auth/email/send-code", { email });
        return { browser, email, code: t.lastLoginCode(email), inviteCode: await t.createInvite() };
      }),
    );

    const results = await Promise.all(
      people.map(({ browser, email, code, inviteCode }) =>
        browser.post("/api/auth/email/verify", { email, code, inviteCode, acceptTerms: true }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403, 403]);
  });
});
