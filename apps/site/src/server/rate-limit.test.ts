import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";
import { clientAddress, clientIp, RateLimiter } from "./rate-limit";
import { adminSettings, adminSettingsFrom, readSetting, writeSetting } from "./settings";

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

describe("频率限制：内存", () => {
  it("来源很多时，过了窗口的不再留在内存里", () => {
    let now = 0;
    const limiter = new RateLimiter({ now: () => new Date(now) });
    const rule = (ip: string) => [{ key: `password-ip:${ip}`, limit: 10, windowMs: HOUR }];
    for (let i = 0; i < 20_000; i++) limiter.take(rule(`198.51.${i >> 8}.${i & 255}`));
    expect(limiter.size).toBe(20_000);

    now = 2 * HOUR;
    limiter.take(rule("203.0.113.9"));

    expect(limiter.size).toBe(1);
  });
});

describe("客户端地址：主站前面有几层反向代理（#94）", () => {
  it("0 层用连接的来源地址，不看 X-Forwarded-For；N 层取倒数第 N 个", () => {
    const header = "198.18.0.1, 203.0.113.5, 10.0.0.2";
    expect(clientAddress(header, "10.0.0.3", 0)).toBe("10.0.0.3");
    expect(clientAddress(header, "10.0.0.3", 1)).toBe("10.0.0.2");
    expect(clientAddress(header, "10.0.0.3", 2)).toBe("203.0.113.5");
    // 几个 X-Forwarded-For 头（Node 收到的是数组）连起来算
    expect(clientAddress(["198.18.0.1", "203.0.113.5, 10.0.0.2"], "10.0.0.3", 2)).toBe(
      "203.0.113.5",
    );
  });

  it("头里的地址不到 N 个（绕过了代理）时用连接的来源地址；都没有时是 unknown", () => {
    expect(clientAddress("203.0.113.5", "10.0.0.3", 2)).toBe("10.0.0.3");
    expect(clientAddress(undefined, "10.0.0.3", 1)).toBe("10.0.0.3");
    expect(clientAddress(" , ", "10.0.0.3", 1)).toBe("10.0.0.3");
    expect(clientAddress(undefined, undefined, 0)).toBe("unknown");
  });

  it("IPv4 映射的 IPv6 地址写成 IPv4，别的 IPv6 原样", () => {
    expect(clientAddress(undefined, "::ffff:203.0.113.9", 0)).toBe("203.0.113.9");
    expect(clientAddress("2001:db8::1", "::1", 1)).toBe("2001:db8::1");
  });

  describe("按设置取", () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(() => t.close());

    // 接口的请求经 @hono/node-server 进来时，连接放在 c.env.incoming
    const addressOf = async (forwardedFor: string) => {
      const app = new Hono().get("/", async (c) => c.text(await clientIp(c, t.deps)));
      const env = { incoming: { socket: { remoteAddress: "192.0.2.10" } } };
      const res = await app.request("/", { headers: { "x-forwarded-for": forwardedFor } }, env);
      return res.text();
    };

    it("没改过是 1 层；改成 0 层后伪造的头不起作用；2 层取倒数第二个", async () => {
      expect(await addressOf("198.18.0.1, 203.0.113.5")).toBe("203.0.113.5");
      const admin = { userId: "test-admin" };
      await writeSetting(t.deps, "proxy_hops", admin, 0);
      expect(await addressOf("198.18.0.1, 203.0.113.5")).toBe("192.0.2.10");
      await writeSetting(t.deps, "proxy_hops", admin, 2);
      expect(await addressOf("198.18.0.1, 203.0.113.5")).toBe("198.18.0.1");
    });
  });

  it("安装脚本用环境变量写初始值；库里存了以库里的为准；值不对启动就报错", async () => {
    expect(adminSettingsFrom({})).toBe(adminSettings);
    expect(adminSettingsFrom({ SEEKCLOUD_PROXY_HOPS: " " })).toBe(adminSettings);
    const policy = adminSettingsFrom({ SEEKCLOUD_PROXY_HOPS: "0" });
    const site = { userId: null };
    expect(await policy.defaultValue("proxy_hops", site)).toBe(0);
    expect(await policy.defaultValue("host_offline_grace", site)).toBe(120);

    const t = await createTestApp({ settingsPolicy: policy });
    try {
      expect(await readSetting(t.deps, "proxy_hops", site)).toBe(0);
      const admin = { userId: "test-admin" };
      await writeSetting(t.deps, "proxy_hops", admin, 2);
      expect(await readSetting(t.deps, "proxy_hops", site)).toBe(2);
    } finally {
      await t.close();
    }
    for (const bad of ["-1", "6", "1.5", "one", "0x1"]) {
      expect(() => adminSettingsFrom({ SEEKCLOUD_PROXY_HOPS: bad }), bad).toThrow(
        "SEEKCLOUD_PROXY_HOPS",
      );
    }
  });

  describe("接口和登录", () => {
    let t: TestApp;
    let admin: TestBrowser;
    beforeAll(async () => {
      t = await createTestApp();
      admin = await t.admin();
    });
    afterAll(() => t.close());

    const put = (hops: unknown) =>
      admin.request("/api/settings/proxy-hops", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.70" },
        body: JSON.stringify({ hops }),
      });

    it("读写层数，同时给出按它认出来的你的地址；层数不对 400", async () => {
      const res = await admin.request("/api/settings/proxy-hops", {
        headers: { "x-forwarded-for": "198.18.0.1, 203.0.113.70" },
      });
      expect(await res.json()).toEqual({ hops: 1, yourAddress: "203.0.113.70" });
      expect(await (await put(2)).json()).toEqual({ hops: 2, yourAddress: "unknown" });
      for (const bad of [-1, 6, 1.5, "1"]) expect((await put(bad)).status, String(bad)).toBe(400);
      expect((await t.browser().get("/api/settings/proxy-hops")).status).toBe(401);
    });

    it("0 层时换着伪造 X-Forwarded-For 也绕不过输错密码的限制", async () => {
      expect((await put(0)).status).toBe(200);
      const browser = t.browser();
      for (let i = 0; i < 10; i++) {
        expect((await login(browser, "wrong-password", `198.18.1.${i}`)).status).toBe(400);
      }
      expect((await login(browser, t.adminPassword, "198.18.1.99")).status).toBe(429);
    });
  });
});
