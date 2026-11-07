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

  /** 用密码登录，IP 是 forwardedFor。 */
  async function login(forwardedFor: string) {
    const res = await t.browser().request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
      body: JSON.stringify({ password: t.adminPassword }),
    });
    expect(res.status).toBe(204);
  }

  it("设置密码、登录、发起会话、发消息时记下 IP；IPv6 只记 /64", async () => {
    const { browser } = await t.adminWithGitHub("tracked", "tracked/app");
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

    await login("2001:db8:aa:bb:1:2:3:4");

    expect(await logsOf(userId)).toEqual([
      { event: "login", network: browser.ip },
      { event: "session_start", network: browser.ip },
      { event: "message", network: browser.ip },
      { event: "login", network: "2001:db8:aa:bb::/64" },
    ]);
  });

  it("保存 180 天，过期由定期任务删掉", async () => {
    const userId = await myId(await t.admin());
    t.clock.advance(DAY);
    await login("203.0.113.8");

    // 之前的记录满 180 天先删掉，后来登录的这条还在。
    t.clock.advance(179 * DAY + 60_000);
    await t.runMaintenance();
    expect(await logsOf(userId)).toEqual([{ event: "login", network: "203.0.113.8" }]);

    t.clock.advance(DAY);
    await t.runMaintenance();
    expect(await logsOf(userId)).toHaveLength(0);
  });
});
