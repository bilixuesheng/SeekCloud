import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";
import { networkOf } from "./access-log";
import { accessLogs } from "./db/schema";

const DAY = 24 * 60 * 60_000;

describe("访问记录的网络", () => {
  it("IPv4 原样，IPv6 归到 /64", () => {
    expect(networkOf("203.0.113.7")).toBe("203.0.113.7");
    expect(networkOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:0DB8:0001:0002:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkOf("::1")).toBe("0:0:0:0::/64");
    expect(networkOf("2001:db8:1:2::1.2.3.4")).toBe("2001:db8:1:2::/64");
    expect(networkOf("::ffff:198.51.100.9")).toBe("198.51.100.9");
    expect(networkOf("unknown")).toBe("unknown");
  });
});

describe("访问记录", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const logsOf = (userId: string) =>
    t.db
      .select({ event: accessLogs.event, network: accessLogs.network })
      .from(accessLogs)
      .where(eq(accessLogs.userId, userId))
      .orderBy(accessLogs.at);

  const myId = async (browser: TestBrowser) =>
    ((await (await browser.get("/api/me")).json()) as { id: string }).id;

  /** 用邮箱登录或注册；IP 从 forwardedFor 来（默认用浏览器自己的）。 */
  async function emailSignIn(browser: TestBrowser, email: string, forwardedFor = browser.ip) {
    t.clock.advance(2 * 60_000); // 避开每分钟一次的限制
    await browser.post("/api/auth/email/send-code", { email });
    const res = await browser.request("/api/auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
      body: JSON.stringify({
        email,
        code: t.lastLoginCode(email),
        inviteCode: await t.createInvite(),
        acceptTerms: true,
      }),
    });
    expect(res.status).toBeLessThan(300);
  }

  async function deleteAccount(browser: TestBrowser, email: string) {
    t.clock.advance(2 * 60_000);
    expect((await browser.post("/api/account/delete/send-code", {})).status).toBe(204);
    const code = t.lastLoginCode(email);
    expect((await browser.post("/api/account/delete", { code })).status).toBe(204);
  }

  it("注册、登录、发起会话、发消息时记下 IP；IPv6 只记 /64", async () => {
    const { browser } = await t.signUpWithGitHub("tracked", "tracked/app");
    const userId = await myId(browser);
    const created = await browser.post("/api/sessions", {
      repo: "tracked/app",
      baseBranch: "main",
      text: "看一下代码",
    });
    expect(created.status).toBe(201);
    const { shortId } = (await created.json()) as { shortId: string };
    await t.host.idle();
    expect(
      (await browser.post(`/api/sessions/${shortId}/messages`, { text: "接着改" })).status,
    ).toBe(201);
    // 没发出去的不记
    expect((await browser.post("/api/sessions/nope/messages", { text: "接着改" })).status).toBe(
      404,
    );

    const laptop = t.browser();
    await emailSignIn(laptop, "tracked@example.com", "2001:db8:aa:bb:1:2:3:4");

    expect(await logsOf(userId)).toEqual([
      { event: "register", network: browser.ip },
      { event: "session_start", network: browser.ip },
      { event: "message", network: browser.ip },
      { event: "login", network: "2001:db8:aa:bb::/64" },
    ]);
  });

  it("保存 180 天，过期由定期任务删掉", async () => {
    const browser = t.browser();
    await emailSignIn(browser, "keeper@example.com");
    const userId = await myId(browser);

    t.clock.advance(179 * DAY);
    await t.runMaintenance();
    expect(await logsOf(userId)).toHaveLength(1);

    t.clock.advance(DAY + 60_000);
    await t.runMaintenance();
    expect(await logsOf(userId)).toHaveLength(0);
  });

  it("删除账户后照样留存：和账户断开、清理账户时不跟着删，重新注册的账户也拿不到，满 180 天才删", async () => {
    const browser = t.browser();
    await emailSignIn(browser, "leaver@example.com");
    const userId = await myId(browser);
    await emailSignIn(t.browser(), "leaver@example.com");
    const ids = (await t.db.select().from(accessLogs).where(eq(accessLogs.userId, userId))).map(
      (row) => row.id,
    );
    expect(ids).toHaveLength(2);

    await deleteAccount(browser, "leaver@example.com");
    const retained = () =>
      t.db
        .select()
        .from(accessLogs)
        .then((rows) => rows.filter((row) => ids.includes(row.id)));
    const [first, second] = await retained();
    expect(first?.userId).toBeNull();
    expect(first?.deletedAccount).toEqual(expect.any(String));
    expect(second?.deletedAccount).toBe(first?.deletedAccount);
    expect(first?.deletedAccount).not.toBe(userId);

    // 停用满 14 天，账户整个删掉，访问记录还在
    t.clock.advance(15 * DAY);
    await t.runMaintenance();
    expect(await retained()).toHaveLength(2);

    // 同一个邮箱重新注册：是新账户，旧记录不归它
    const again = t.browser();
    await emailSignIn(again, "leaver@example.com");
    const newId = await myId(again);
    expect(newId).not.toBe(userId);
    expect(await logsOf(newId)).toEqual([{ event: "register", network: again.ip }]);

    t.clock.advance(166 * DAY);
    await t.runMaintenance();
    expect(await retained()).toHaveLength(0);
  });
});
