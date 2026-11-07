import { LEGAL_VERSION } from "@seekcloud/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";
import { users } from "./db/schema";

const MINUTE = 60_000;

/** 发验证码。先把时钟往后拨，避开同一邮箱的发送频率限制（限制本身在 rate-limit.test.ts 里测）。 */
function sendCode(t: TestApp, browser: TestBrowser, email: string) {
  t.clock.advance(13 * MINUTE);
  return browser.post("/api/auth/email/send-code", { email });
}

/** 发验证码并带上它去校验，返回校验的响应。 */
async function signIn(
  t: TestApp,
  browser: TestBrowser,
  email: string,
  extra: { inviteCode?: string; acceptTerms?: boolean } = {},
) {
  await sendCode(t, browser, email);
  return browser.post("/api/auth/email/verify", {
    email,
    code: t.lastLoginCode(email.trim().toLowerCase()),
    ...extra,
  });
}

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("发验证码", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("邮件发到规范化后的邮箱，正文里有 6 位数字", async () => {
    const res = await t
      .browser()
      .post("/api/auth/email/send-code", { email: "  Alice@Example.COM " });

    expect(res.status).toBe(204);
    expect(t.mailer.sent.at(-1)?.to).toBe("alice@example.com");
    expect(t.mailer.sent.at(-1)?.text).toMatch(/\b\d{6}\b/);
  });

  it("邮件发不出去时返回 502；这次不算进发送次数，可以马上重试", async () => {
    const browser = t.browser();
    t.mailer.failNext();

    const res = await browser.post("/api/auth/email/send-code", { email: "bob@example.com" });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: "mail_failed", message: "验证码邮件发送失败，请稍后重试" },
    });
    const retry = await browser.post("/api/auth/email/send-code", { email: "bob@example.com" });
    expect(retry.status).toBe(204);
  });

  it("邮箱格式错误时返回 400 和中文说明", async () => {
    const res = await t.browser().post("/api/auth/email/send-code", { email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_request", message: "邮箱格式错误" },
    });
  });
});

describe("注册", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("新邮箱：验证码加有效邀请码就能注册，并且已经登录", async () => {
    const alice = t.browser();

    const res = await signIn(t, alice, "alice@example.com", {
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });

    expect(res.status).toBe(201);
    const me = await alice.get("/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "alice@example.com" });
  });

  it("注册后自动有一个默认环境：默认清单", async () => {
    const bob = t.browser();
    await signIn(t, bob, "bob@example.com", {
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });

    const res = await bob.get("/api/environments");

    expect(await res.json()).toEqual({
      environments: [
        { id: expect.any(String), name: "默认环境", networkAccess: "default", isDefault: true },
      ],
    });
  });

  it("邀请码不分大小写，可以不写中间的横线", async () => {
    const invite = await t.createInvite();

    const res = await signIn(t, t.browser(), "carol@example.com", {
      inviteCode: invite.replace("-", "").toLowerCase(),
      acceptTerms: true,
    });

    expect(res.status).toBe(201);
  });

  it("新邮箱没带邀请码：提示填邀请码，验证码不作废，补上邀请码就能注册", async () => {
    const dave = t.browser();
    const first = await signIn(t, dave, "dave@example.com");
    expect(first.status).toBe(400);
    expect(await errorCode(first)).toBe("invite_required");

    const second = await dave.post("/api/auth/email/verify", {
      email: "dave@example.com",
      code: t.lastLoginCode("dave@example.com"),
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });

    expect(second.status).toBe(201);
  });

  it("注册要同意用户协议和隐私政策：没同意时 400，不建账户，邀请码和验证码都没用掉；同意的版本记在账户上", async () => {
    const ivan = t.browser();
    const invite = await t.createInvite();
    const refused = await signIn(t, ivan, "ivan@example.com", { inviteCode: invite });
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("terms_required");
    expect((await ivan.get("/api/me")).status).toBe(401);

    const agreed = await ivan.post("/api/auth/email/verify", {
      email: "ivan@example.com",
      code: t.lastLoginCode("ivan@example.com"),
      inviteCode: invite,
      acceptTerms: true,
    });
    expect(agreed.status).toBe(201);
    const [row] = await t.db
      .select({ version: users.termsVersion, at: users.termsAcceptedAt })
      .from(users)
      .where(eq(users.email, "ivan@example.com"));
    expect(row).toEqual({ version: LEGAL_VERSION, at: t.clock.now() });

    // 老用户以后登录不用再同意一次。
    const later = await signIn(t, t.browser(), "ivan@example.com");
    expect(later.status).toBe(200);
  });

  it("邀请码只能用一次", async () => {
    const invite = await t.createInvite();
    await signIn(t, t.browser(), "erin@example.com", { inviteCode: invite, acceptTerms: true });

    const res = await signIn(t, t.browser(), "frank@example.com", {
      inviteCode: invite,
      acceptTerms: true,
    });

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invite_used");
  });

  it("邀请码不存在", async () => {
    const res = await signIn(t, t.browser(), "grace@example.com", {
      inviteCode: "AAAA-BBBB",
      acceptTerms: true,
    });

    expect(await errorCode(res)).toBe("invite_invalid");
  });

  it("邀请码过期后不能用", async () => {
    const invite = await t.createInvite({
      expiresAt: new Date(t.clock.now().getTime() + 60 * MINUTE),
    });
    t.clock.advance(61 * MINUTE);

    const res = await signIn(t, t.browser(), "heidi@example.com", {
      inviteCode: invite,
      acceptTerms: true,
    });

    expect(await errorCode(res)).toBe("invite_expired");
  });
});

describe("注册：内测席位已满", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ seatLimit: 1 });
  });
  afterAll(() => t.close());

  it("用户数到了席位上限，新用户注册时提示名额已满", async () => {
    await signIn(t, t.browser(), "first@example.com", {
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });

    const res = await signIn(t, t.browser(), "second@example.com", {
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "seats_full", message: "内测名额已满" } });
  });

  it("新邮箱发完验证码就提示名额已满，不用先填邀请码", async () => {
    const res = await signIn(t, t.browser(), "third@example.com");

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("seats_full");
  });

  it("已有的用户照样能登录", async () => {
    const res = await signIn(t, t.browser(), "first@example.com");

    expect(res.status).toBe(200);
  });
});

describe("登录", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await signIn(t, t.browser(), "alice@example.com", {
      inviteCode: await t.createInvite(),
      acceptTerms: true,
    });
  });
  afterAll(() => t.close());

  it("已注册的邮箱只要验证码就能登录，大小写和空格不影响", async () => {
    const alice = t.browser();

    const res = await signIn(t, alice, "  ALICE@example.com ");

    expect(res.status).toBe(200);
    expect(await (await alice.get("/api/me")).json()).toMatchObject({ email: "alice@example.com" });
  });

  it("验证码不对时返回 invalid_code", async () => {
    const alice = t.browser();
    await sendCode(t, alice, "alice@example.com");
    const wrong = t.lastLoginCode("alice@example.com") === "000000" ? "111111" : "000000";

    const res = await alice.post("/api/auth/email/verify", {
      email: "alice@example.com",
      code: wrong,
    });

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_code");
  });

  it("错 5 次以后，正确的验证码也不能用了", async () => {
    const alice = t.browser();
    await sendCode(t, alice, "alice@example.com");
    const code = t.lastLoginCode("alice@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await alice.post("/api/auth/email/verify", { email: "alice@example.com", code: wrong });
    }

    const res = await alice.post("/api/auth/email/verify", { email: "alice@example.com", code });

    expect(await errorCode(res)).toBe("invalid_code");
  });

  it("验证码 10 分钟后过期", async () => {
    const alice = t.browser();
    await sendCode(t, alice, "alice@example.com");
    t.clock.advance(10 * MINUTE + 1);

    const res = await alice.post("/api/auth/email/verify", {
      email: "alice@example.com",
      code: t.lastLoginCode("alice@example.com"),
    });

    expect(await errorCode(res)).toBe("invalid_code");
  });

  it("发了新验证码，旧的就不能用了", async () => {
    const alice = t.browser();
    await sendCode(t, alice, "alice@example.com");
    const old = t.lastLoginCode("alice@example.com");
    // 新旧验证码碰巧一样的概率是百万分之一；真碰上了就再发一次。
    do await sendCode(t, alice, "alice@example.com");
    while (t.lastLoginCode("alice@example.com") === old);

    const res = await alice.post("/api/auth/email/verify", {
      email: "alice@example.com",
      code: old,
    });

    expect(await errorCode(res)).toBe("invalid_code");
  });

  it("验证码用过一次就作废", async () => {
    const alice = t.browser();
    await signIn(t, alice, "alice@example.com");

    const again = await alice.post("/api/auth/email/verify", {
      email: "alice@example.com",
      code: t.lastLoginCode("alice@example.com"),
    });

    expect(await errorCode(again)).toBe("invalid_code");
  });

  it("退出登录后，再访问需要登录的接口返回 401", async () => {
    const alice = t.browser();
    await signIn(t, alice, "alice@example.com");

    expect((await alice.post("/api/auth/logout")).status).toBe(204);

    const me = await alice.get("/api/me");
    expect(me.status).toBe(401);
    expect(await me.json()).toEqual({ error: { code: "unauthorized", message: "请先登录" } });
  });

  it("登录状态 30 天后失效", async () => {
    const alice = t.browser();
    await signIn(t, alice, "alice@example.com");
    t.clock.advance(30 * 24 * 60 * MINUTE + 1);

    expect((await alice.get("/api/me")).status).toBe(401);
  });
});
