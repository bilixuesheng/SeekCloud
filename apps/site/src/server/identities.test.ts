import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const MINUTE = 60_000;

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
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
