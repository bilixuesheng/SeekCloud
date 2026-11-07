import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const MINUTE = 60_000;

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("人机验证（配了 Turnstile）", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ humanCheck: true });
  });
  afterAll(() => t.close());

  /** 发验证码。先把时钟往后拨，避开同一邮箱的发送频率限制。 */
  const sendCode = (browser: TestBrowser, email: string, token?: string) => {
    t.clock.advance(13 * MINUTE);
    return browser.post("/api/auth/email/send-code", { email, humanCheckToken: token });
  };

  it("浏览器从接口拿到站点密钥", async () => {
    const res = await t.browser().get("/api/client-config");
    expect(await res.json()).toMatchObject({ turnstileSiteKey: "test-site-key" });
  });

  it("发验证码：令牌有效才发信；去 Cloudflare 校验时带上客户端 IP 和操作", async () => {
    const browser = t.browser();
    const res = await sendCode(browser, "ok@example.com", t.humanCheck.tokenFor("send_code"));

    expect(res.status).toBe(204);
    expect(t.mailer.sent.at(-1)?.to).toBe("ok@example.com");
    expect(t.humanCheck.calls.at(-1)).toEqual({
      token: "ok:send_code",
      action: "send_code",
      ip: browser.ip,
    });
  });

  it("发验证码：令牌无效、拿别的操作的令牌来用：400，不发信", async () => {
    const browser = t.browser();
    const before = t.mailer.sent.length;

    const bad = await sendCode(browser, "bot@example.com", "forged");
    const wrongAction = await sendCode(browser, "bot@example.com", t.humanCheck.tokenFor("signup"));

    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("human_check_failed");
    expect(wrongAction.status).toBe(400);
    expect(t.mailer.sent.length).toBe(before);
    // 没通过不占发送次数：拿到有效令牌后马上能发。
    const ok = await browser.post("/api/auth/email/send-code", {
      email: "bot@example.com",
      humanCheckToken: t.humanCheck.tokenFor("send_code"),
    });
    expect(ok.status).toBe(204);
  });

  it("发验证码：伪造的令牌一直试，同一个 IP 一小时最多问 Cloudflare 20 次", async () => {
    const browser = t.browser();
    const before = t.humanCheck.calls.length;
    const results: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await browser.post("/api/auth/email/send-code", {
        email: `spam${i}@example.com`,
        humanCheckToken: "forged",
      });
      results.push(res.status);
    }

    expect(results.filter((s) => s === 400)).toHaveLength(20);
    expect(results.slice(20)).toEqual([429, 429, 429, 429, 429]);
    expect(t.humanCheck.calls.length - before).toBe(20);
  });

  it("发验证码：浏览器连不上 Cloudflare、没拿到令牌：照常发，但同一个 IP 一小时最多 3 次", async () => {
    const browser = t.browser();
    for (const name of ["a", "b", "c"]) {
      expect((await sendCode(browser, `${name}@no-check.example.com`)).status).toBe(204);
    }

    const fourth = await sendCode(browser, "d@no-check.example.com");

    expect(fourth.status).toBe(429);
    // 别的 IP 不受影响。
    expect((await sendCode(t.browser(), "e@no-check.example.com")).status).toBe(204);
  });

  it("发验证码：主站连不上 Cloudflare：照常发，老用户不会因为第三方出问题登不进来", async () => {
    t.humanCheck.down();
    try {
      const res = await sendCode(t.browser(), "down@example.com", "anything");
      expect(res.status).toBe(204);
    } finally {
      t.humanCheck.up();
    }
  });

  describe("邮箱注册", () => {
    /** 发验证码、填邀请码注册。 */
    const signUp = async (email: string, token: string | undefined, inviteCode: string) => {
      const browser = t.browser();
      await sendCode(browser, email, t.humanCheck.tokenFor("send_code"));
      const res = await browser.post("/api/auth/email/verify", {
        email,
        code: t.lastLoginCode(email),
        inviteCode,
        acceptTerms: true,
        humanCheckToken: token,
      });
      return { browser, res };
    };

    it("没带令牌、令牌无效：400，不建账户，邀请码和验证码都没用掉", async () => {
      const inviteCode = await t.createInvite();
      const browser = t.browser();
      await sendCode(browser, "new@example.com", t.humanCheck.tokenFor("send_code"));
      const code = t.lastLoginCode("new@example.com");

      const missing = await browser.post("/api/auth/email/verify", {
        email: "new@example.com",
        code,
        inviteCode,
        acceptTerms: true,
      });
      const forged = await browser.post("/api/auth/email/verify", {
        email: "new@example.com",
        code,
        inviteCode,
        acceptTerms: true,
        humanCheckToken: "forged",
      });
      expect(missing.status).toBe(400);
      expect(await errorCode(missing)).toBe("human_check_failed");
      expect(forged.status).toBe(400);
      expect((await browser.get("/api/me")).status).toBe(401);

      const ok = await browser.post("/api/auth/email/verify", {
        email: "new@example.com",
        code,
        inviteCode,
        acceptTerms: true,
        humanCheckToken: t.humanCheck.tokenFor("signup"),
      });
      expect(ok.status).toBe(201);
    });

    it("主站连不上 Cloudflare：503，请稍后再注册", async () => {
      t.humanCheck.down();
      try {
        const { res } = await signUp("later@example.com", "anything", await t.createInvite());
        expect(res.status).toBe(503);
        expect(await errorCode(res)).toBe("human_check_unavailable");
      } finally {
        t.humanCheck.up();
      }
    });

    it("老用户用验证码登录：不用人机验证", async () => {
      await signUp("old@example.com", t.humanCheck.tokenFor("signup"), await t.createInvite());
      const browser = t.browser();
      await sendCode(browser, "old@example.com", t.humanCheck.tokenFor("send_code"));

      const res = await browser.post("/api/auth/email/verify", {
        email: "old@example.com",
        code: t.lastLoginCode("old@example.com"),
      });

      expect(res.status).toBe(200);
    });
  });

  it("GitHub 注册：没带令牌 400；带了有效令牌才注册", async () => {
    const octo = t.github.addUser({ login: "octo-hc", email: "octo-hc@example.com" });
    const browser = t.browser();
    const start = await browser.get("/api/auth/github/start");
    const state = new URL(start.headers.get("location") as string).searchParams.get("state");
    await browser.get(`/api/auth/github/callback?code=${t.github.authorize(octo)}&state=${state}`);
    const inviteCode = await t.createInvite();

    const missing = await browser.post("/api/auth/pending/register", {
      inviteCode,
      acceptTerms: true,
    });
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe("human_check_failed");

    const ok = await browser.post("/api/auth/pending/register", {
      inviteCode,
      acceptTerms: true,
      humanCheckToken: t.humanCheck.tokenFor("signup"),
    });
    expect(ok.status).toBe(201);
  });
});

describe("没配 Turnstile（开发和测试）", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("不验证：站点密钥是 null，不带令牌也能发验证码", async () => {
    const config = await t.browser().get("/api/client-config");
    expect(await config.json()).toMatchObject({ turnstileSiteKey: null });

    const res = await t.browser().post("/api/auth/email/send-code", { email: "dev@example.com" });
    expect(res.status).toBe(204);
  });
});
