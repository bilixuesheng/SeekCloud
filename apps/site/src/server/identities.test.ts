import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeGoogleUser } from "../testing/fake-google";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const MINUTE = 60_000;

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** 点"用 Google 继续"，在 Google 上同意，再跳回来。返回跳回来那一步的响应。 */
async function googleSignIn(
  t: TestApp,
  browser: TestBrowser,
  user: FakeGoogleUser,
  options: { next?: string; nonce?: string } = {},
) {
  const start = await browser.get(
    `/api/auth/google/start${options.next ? `?next=${encodeURIComponent(options.next)}` : ""}`,
  );
  expect(start.status).toBe(302);
  const url = start.headers.get("location") as string;
  const state = new URL(url).searchParams.get("state");
  const code = t.google.authorize(user, url, { nonce: options.nonce });
  return browser.get(`/api/auth/google/callback?code=${code}&state=${state}`);
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

describe("用 Google 注册和登录", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("浏览器配置里说明可以用 Google 登录", async () => {
    expect(await json(await t.browser().get("/api/client-config"))).toMatchObject({
      googleLogin: true,
    });
  });

  it("新的 Google 账号：先让用户选，选创建新账户就填邀请码注册，账户邮箱用 Google 的邮箱", async () => {
    const google = t.google.addUser({ email: "new-g@example.com" });
    const browser = t.browser();

    const callback = await googleSignIn(t, browser, google);
    expect(callback.headers.get("location")).toBe("/?signin=pending");
    expect(await json(await browser.get("/api/auth/pending"))).toEqual({
      provider: "google",
      login: "new-g@example.com",
      email: "new-g@example.com",
      emailTaken: false,
      canRegister: true,
    });

    // 没同意用户协议和隐私政策：不注册，待处理的身份还在，同意后接着注册。
    const invite = await t.createInvite();
    const refused = await browser.post("/api/auth/pending/register", { inviteCode: invite });
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("terms_required");
    expect((await browser.get("/api/auth/pending")).status).toBe(200);

    const done = await browser.post("/api/auth/pending/register", {
      inviteCode: invite,
      acceptTerms: true,
    });
    expect(done.status).toBe(201);
    expect(await json(await browser.get("/api/me"))).toMatchObject({ email: "new-g@example.com" });
    expect(await json(await browser.get("/api/account/identities"))).toEqual({
      email: "new-g@example.com",
      identities: [{ provider: "google", login: "new-g@example.com" }],
    });
    expect((await browser.get("/api/auth/pending")).status).toBe(404);
  });

  it("已经绑定过的 Google 账号直接登录", async () => {
    const google = t.google.addUser({ email: "again@example.com" });
    const first = t.browser();
    await googleSignIn(t, first, google);
    await first.post("/api/auth/pending/register", {
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });

    const later = t.browser();
    const callback = await googleSignIn(t, later, google);

    expect(callback.headers.get("location")).toBe("/");
    expect(await json(await later.get("/api/me"))).toMatchObject({ email: "again@example.com" });
  });

  it("Google 的邮箱已经是别的账户的：不能注册，要先登录那个账户，确认后才绑定", async () => {
    await emailAccount(t, "owner@example.com");
    const google = t.google.addUser({ email: "owner@example.com" });
    const browser = t.browser();

    await googleSignIn(t, browser, google);
    expect(await json(await browser.get("/api/auth/pending"))).toMatchObject({
      provider: "google",
      emailTaken: true,
      canRegister: false,
    });
    const register = await browser.post("/api/auth/pending/register", {
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });
    expect(register.status).toBe(409);
    expect(await errorCode(register)).toBe("email_taken");

    // 登录以后不会自动绑定：要用户确认。
    await emailLogin(t, browser, "owner@example.com");
    expect((await json(await browser.get("/api/account/identities"))).identities).toEqual([]);
    const link = await browser.post("/api/auth/pending/link", {});
    expect(link.status).toBe(200);
    expect(await json(link)).toEqual({ provider: "google", login: "owner@example.com" });

    const viaGoogle = t.browser();
    expect((await googleSignIn(t, viaGoogle, google)).headers.get("location")).toBe("/");
    expect(await json(await viaGoogle.get("/api/me"))).toMatchObject({
      email: "owner@example.com",
    });
  });

  it("陌生的 Google 账号、邮箱也对不上：可以选登录已有账户再绑定", async () => {
    await emailAccount(t, "someone@example.com");
    const google = t.google.addUser({ email: "personal@gmail.example" });
    const browser = t.browser();

    await googleSignIn(t, browser, google);
    await emailLogin(t, browser, "someone@example.com");
    const link = await browser.post("/api/auth/pending/link", {});

    expect(link.status).toBe(200);
    expect(await json(await browser.get("/api/account/identities"))).toEqual({
      email: "someone@example.com",
      identities: [{ provider: "google", login: "personal@gmail.example" }],
    });
  });

  it("不想绑定：放弃以后待处理的身份就没了", async () => {
    const google = t.google.addUser({ email: "cancel@example.com" });
    const browser = t.browser();
    await googleSignIn(t, browser, google);

    expect((await browser.post("/api/auth/pending/cancel", {})).status).toBe(204);
    expect((await browser.get("/api/auth/pending")).status).toBe(404);
  });

  it("没登录不能绑定；待处理的身份 10 分钟后过期", async () => {
    const google = t.google.addUser({ email: "slow@example.com" });
    const browser = t.browser();
    await googleSignIn(t, browser, google);

    const anonymous = await browser.post("/api/auth/pending/link", {});
    expect(anonymous.status).toBe(401);

    t.clock.advance(11 * MINUTE);
    expect((await browser.get("/api/auth/pending")).status).toBe(404);
  });

  it("账户已经绑定了一个 Google 账号，再绑另一个：拒绝并说明原因", async () => {
    const browser = await emailAccount(t, "two-googles@example.com");
    const first = t.google.addUser({ email: "g1@example.com" });
    const second = t.google.addUser({ email: "g2@example.com" });
    expect(
      (await googleSignIn(t, browser, first, { next: "/settings" })).headers.get("location"),
    ).toBe("/settings");

    const again = await googleSignIn(t, browser, second, { next: "/settings" });

    expect(again.headers.get("location")).toBe("/settings?google=already_linked");
  });

  it("已经属于别的账户的 Google 账号：不能再绑定", async () => {
    const google = t.google.addUser({ email: "taken-g@example.com" });
    const owner = t.browser();
    await googleSignIn(t, owner, google);
    await owner.post("/api/auth/pending/register", {
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });
    const other = await emailAccount(t, "thief@example.com");

    const callback = await googleSignIn(t, other, google, { next: "/settings" });

    expect(callback.headers.get("location")).toBe("/settings?google=identity_taken");
  });

  it("跳回来时 state 或 nonce 对不上：拒绝", async () => {
    const google = t.google.addUser({ email: "replay@example.com" });
    const browser = t.browser();

    const badNonce = await googleSignIn(t, browser, google, { nonce: "attacker" });
    expect(badNonce.headers.get("location")).toBe("/?google=failed");

    const noState = await browser.get("/api/auth/google/callback?code=x&state=y");
    expect(noState.headers.get("location")).toBe("/?google=failed");
  });

  it("Google 没确认过的邮箱：不接受", async () => {
    const google = t.google.addUser({ email: "unverified@example.com", emailVerified: false });

    const callback = await googleSignIn(t, t.browser(), google);

    expect(callback.headers.get("location")).toBe("/?google=unverified_email");
  });

  it("next 只能是站内的几个页面，防止跳到别的网站", async () => {
    const google = t.google.addUser({ email: "redirect@example.com" });
    const browser = await emailAccount(t, "redirect-owner@example.com");

    const callback = await googleSignIn(t, browser, google, { next: "//evil.example.com" });

    expect(callback.headers.get("location")).toBe("/");
  });
});

describe("没配 Google", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ google: false });
  });
  afterAll(() => t.close());

  it("登录页不显示 Google；直接访问登录地址会提示不可用", async () => {
    expect(await json(await t.browser().get("/api/client-config"))).toMatchObject({
      googleLogin: false,
    });
    const start = await t.browser().get("/api/auth/google/start");
    expect(start.headers.get("location")).toBe("/?google=unavailable");
  });
});

describe("用 GitHub 时也一样", () => {
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

  it("解绑 Google 以后不能再用它登录到这个账户", async () => {
    const browser = await emailAccount(t, "unlink@example.com");
    const google = t.google.addUser({ email: "unlink-g@example.com" });
    await googleSignIn(t, browser, google, { next: "/settings" });

    expect(
      (await browser.post("/api/account/identities/unlink", { provider: "google" })).status,
    ).toBe(204);

    expect((await json(await browser.get("/api/account/identities"))).identities).toEqual([]);
    const later = t.browser();
    expect((await googleSignIn(t, later, google)).headers.get("location")).toBe("/?signin=pending");
  });

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
    const res = await browser.post("/api/account/identities/unlink", { provider: "google" });
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
