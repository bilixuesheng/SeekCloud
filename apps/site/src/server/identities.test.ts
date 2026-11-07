import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const MINUTE = 60_000;

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** 用邮箱验证码注册并登录一个新账户。 */
async function emailAccount(t: TestApp, email: string) {
  const browser = t.browser();
  t.clock.advance(2 * MINUTE);
  await browser.post("/api/auth/email/send-code", { email });
  const res = await browser.post("/api/auth/email/verify", {
    email,
    code: t.lastLoginCode(email),
    inviteCode: await t.createInvite(),
    acceptTerms: true,
  });
  expect(res.status).toBe(201);
  return browser;
}

/** 已有账户的人在这个浏览器里用邮箱验证码登录。 */
async function emailLogin(t: TestApp, browser: TestBrowser, email: string) {
  t.clock.advance(2 * MINUTE);
  await browser.post("/api/auth/email/send-code", { email });
  const res = await browser.post("/api/auth/email/verify", { email, code: t.lastLoginCode(email) });
  expect(res.status).toBe(200);
}

describe("陌生的 GitHub 账号：登录已有账户后绑定", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("GitHub 的邮箱已经是别的账户的：登录那个账户、确认后绑定，GitHub 令牌也一起存上", async () => {
    await emailAccount(t, "dev@example.com");
    const gh = t.github.addUser({ login: "dev-gh", email: "dev@example.com" });
    t.github.install(gh, { fullName: "dev-gh/app" });
    const browser = t.browser();
    const start = await browser.get("/api/auth/github/start");
    const state = new URL(start.headers.get("location") as string).searchParams.get("state");
    const callback = await browser.get(
      `/api/auth/github/callback?code=${t.github.authorize(gh)}&state=${state}`,
    );
    expect(callback.headers.get("location")).toBe("/?signin=pending");
    expect(await json(await browser.get("/api/auth/pending"))).toMatchObject({
      provider: "github",
      login: "dev-gh",
      emailTaken: true,
    });

    await emailLogin(t, browser, "dev@example.com");
    expect((await browser.post("/api/auth/pending/link", {})).status).toBe(200);

    expect(await json(await browser.get("/api/github/status"))).toMatchObject({
      connected: true,
      login: "dev-gh",
    });
  });
});

describe("账户设置：解绑", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("解绑 GitHub：GitHub 令牌也删掉，显示为未关联", async () => {
    const { browser } = await t.signUpWithGitHub("unlink-gh", "unlink-gh/app");

    expect(
      (await browser.post("/api/account/identities/unlink", { provider: "github" })).status,
    ).toBe(204);

    expect(await json(await browser.get("/api/github/status"))).toMatchObject({ connected: false });
    // 邮箱验证码登录一直可用，所以第三方身份都能解绑，账户不会登不进去。
    expect(await json(await browser.get("/api/me"))).toMatchObject({
      email: "unlink-gh@example.com",
    });
  });

  it("没绑定的身份：404", async () => {
    const browser = await emailAccount(t, "nothing@example.com");
    const res = await browser.post("/api/account/identities/unlink", { provider: "github" });
    expect(res.status).toBe(404);
  });
});

describe("账户设置：在所有设备上退出", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("手机和电脑都登录着：在一台上点退出所有设备，两台都退出；别人的登录不受影响", async () => {
    const laptop = await emailAccount(t, "everywhere@example.com");
    const phone = t.browser();
    await emailLogin(t, phone, "everywhere@example.com");
    const someoneElse = await emailAccount(t, "bystander@example.com");

    expect((await laptop.post("/api/auth/logout-all", {})).status).toBe(204);

    expect((await laptop.get("/api/me")).status).toBe(401);
    expect((await phone.get("/api/me")).status).toBe(401);
    expect((await someoneElse.get("/api/me")).status).toBe(200);
  });
});

describe("账户设置：换邮箱", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("向新邮箱发验证码，填对以后生效；旧邮箱收到通知；之后用新邮箱登录", async () => {
    const browser = await emailAccount(t, "old@example.com");

    const send = await browser.post("/api/account/email/send-code", { email: " New@Example.com " });
    expect(send.status).toBe(204);
    expect(t.mailer.sent.at(-1)?.to).toBe("new@example.com");

    const confirm = await browser.post("/api/account/email/confirm", {
      code: t.lastLoginCode("new@example.com"),
    });
    expect(confirm.status).toBe(200);
    expect(await json(confirm)).toEqual({ email: "new@example.com" });
    expect(await json(await browser.get("/api/me"))).toMatchObject({ email: "new@example.com" });
    const notice = t.mailer.sent.at(-1);
    expect(notice?.to).toBe("old@example.com");
    expect(notice?.text).toContain("new@example.com");

    await emailLogin(t, t.browser(), "new@example.com");
  });

  it("新邮箱已经是别的账户的：409；和现在的一样：400", async () => {
    await emailAccount(t, "occupied@example.com");
    const browser = await emailAccount(t, "mover@example.com");

    const taken = await browser.post("/api/account/email/send-code", {
      email: "occupied@example.com",
    });
    const same = await browser.post("/api/account/email/send-code", { email: "mover@example.com" });

    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe("email_taken");
    expect(same.status).toBe(400);
    expect(await errorCode(same)).toBe("same_email");
  });

  it("验证码填错 5 次就作废，填对的也不行了；要重新发", async () => {
    const browser = await emailAccount(t, "guess@example.com");
    await browser.post("/api/account/email/send-code", { email: "guessed@example.com" });
    const code = t.lastLoginCode("guessed@example.com");
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) {
      const res = await browser.post("/api/account/email/confirm", { code: wrong });
      expect(res.status).toBe(400);
    }
    const right = await browser.post("/api/account/email/confirm", { code });

    expect(right.status).toBe(400);
    expect(await json(await browser.get("/api/me"))).toMatchObject({ email: "guess@example.com" });
  });

  it("验证码 10 分钟后过期；同一个账户 1 分钟内只能发一次", async () => {
    const browser = await emailAccount(t, "late@example.com");
    await browser.post("/api/account/email/send-code", { email: "late-new@example.com" });
    const again = await browser.post("/api/account/email/send-code", {
      email: "late-new@example.com",
    });
    expect(again.status).toBe(429);

    const code = t.lastLoginCode("late-new@example.com");
    t.clock.advance(11 * MINUTE);
    const res = await browser.post("/api/account/email/confirm", { code });
    expect(res.status).toBe(400);
  });

  it("没登录：401", async () => {
    const res = await t.browser().post("/api/account/email/send-code", { email: "x@example.com" });
    expect(res.status).toBe(401);
  });
});
