import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";

const DAY = 24 * 60 * 60_000;
/** 网页的 api() 删除时也带着 JSON 的类型（client/api.ts）；不带的话同站检查按表单算。 */
const JSON_DELETE = {
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: "{}",
};

interface Device {
  id: string;
  client: "browser" | "app";
  deviceName: string | null;
  current: boolean;
  lastUsedAt: string | null;
}

/** 安卓 App 的设备令牌和设置里的设备列表（#177）。身份来源都要守的规矩见 identity-contract.ts。 */
describe("设备令牌和设备列表", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp({ streamKeepaliveMs: 50 });
    browser = await t.admin();
  });
  afterAll(() => t.close());

  const appLogIn = async (deviceName = "Pixel 9") => {
    const res = await t
      .browser()
      .post("/api/auth/login", { password: t.adminPassword, client: "app", deviceName });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    return ((await res.json()) as { token: string }).token;
  };
  const asApp = (token: string, path: string, init: RequestInit = {}) =>
    t.browser().request(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });
  const devices = async (b: TestBrowser = browser) =>
    ((await (await b.get("/api/auth/devices")).json()) as { devices: Device[] }).devices;

  it("App 登录：不设 Cookie，回令牌；设备列表里有它的名字，当前这台标出来", async () => {
    const token = await appLogIn("Pixel 9");
    expect((await asApp(token, "/api/me")).status).toBe(200);
    const list = await devices();
    expect(list.find((d) => d.client === "app")).toMatchObject({
      deviceName: "Pixel 9",
      current: false,
    });
    expect(list.find((d) => d.current)).toMatchObject({ client: "browser", deviceName: null });
    const fromApp = (await (await asApp(token, "/api/auth/devices")).json()) as {
      devices: Device[];
    };
    expect(fromApp.devices.find((d) => d.current)).toMatchObject({ client: "app" });
  });

  it("设备名太长不收；没给设备名时有个默认的", async () => {
    const long = await t.browser().post("/api/auth/login", {
      password: t.adminPassword,
      client: "app",
      deviceName: "长".repeat(101),
    });
    expect(long.status).toBe(400);
    const res = await t
      .browser()
      .post("/api/auth/login", { password: t.adminPassword, client: "app" });
    const { token } = (await res.json()) as { token: string };
    const list = (await (await asApp(token, "/api/auth/devices")).json()) as { devices: Device[] };
    expect(list.devices.find((d) => d.current)?.deviceName).toBe("安卓设备");
  });

  it("带令牌、不带 Origin 的表单请求能过；只带 Cookie 的别的网站的表单请求照旧拦下", async () => {
    const token = await appLogIn();
    const form = { "content-type": "text/plain", origin: "https://evil.example" };
    const viaApp = await asApp(token, "/api/auth/logout", {
      method: "POST",
      headers: form,
      body: "x",
    });
    expect(viaApp.status).toBe(204);
    const viaCookie = await browser.clone().request("/api/auth/logout", {
      method: "POST",
      headers: form,
      body: "x",
    });
    expect(viaCookie.status).toBe(403);
    expect((await browser.get("/api/me")).status).toBe(200);
  });

  it("单独退出一台：它的令牌马上失效，连着的事件流断开；别的设备不受影响；不是自己的、不存在的回 404", async () => {
    const token = await appLogIn("要退出的手机");
    const stream = await t
      .browser()
      .stream("/api/sessions/stream", { authorization: `Bearer ${token}` });
    const target = (await devices()).find((d) => d.deviceName === "要退出的手机") as Device;
    expect((await browser.request(`/api/auth/devices/${target.id}`, JSON_DELETE)).status).toBe(204);
    expect((await asApp(token, "/api/me")).status).toBe(401);
    // 下一次保活时断开
    const ended = await (async () => {
      for (;;) {
        try {
          await stream.next(3000);
        } catch (error) {
          return String(error);
        }
      }
    })();
    expect(ended).toContain("事件流已经结束");
    expect((await browser.get("/api/me")).status).toBe(200);
    expect((await browser.request(`/api/auth/devices/${target.id}`, JSON_DELETE)).status).toBe(404);
    expect((await browser.request("/api/auth/devices/not-a-uuid", JSON_DELETE)).status).toBe(400);
  });

  it("App 的令牌一直在用就一直有效，30 天没用过才失效；浏览器的照旧从登录时算 30 天", async () => {
    const token = await appLogIn("常用的手机");
    const fresh = await t.admin();
    for (let i = 0; i < 3; i++) {
      t.clock.advance(20 * DAY);
      expect((await asApp(token, "/api/me")).status).toBe(200);
    }
    // 浏览器那台登录了 60 天，过期了
    expect((await fresh.get("/api/me")).status).toBe(401);
    t.clock.advance(31 * DAY);
    expect((await asApp(token, "/api/me")).status).toBe(401);
    browser = await t.admin();
  });

  it("改密码、在所有设备上退出时，App 的令牌也失效", async () => {
    const before = await appLogIn("改密码前的手机");
    const newPassword = `${t.adminPassword}-2`;
    expect(
      (
        await browser.post("/api/auth/password", {
          currentPassword: t.adminPassword,
          newPassword,
        })
      ).status,
    ).toBe(204);
    expect((await asApp(before, "/api/me")).status).toBe(401);
    expect((await browser.get("/api/me")).status).toBe(200);

    const res = await t
      .browser()
      .post("/api/auth/login", { password: newPassword, client: "app", deviceName: "新手机" });
    const { token } = (await res.json()) as { token: string };
    expect((await browser.post("/api/auth/logout-all")).status).toBe(204);
    expect((await asApp(token, "/api/me")).status).toBe(401);
  });

  it("/api/health 没登录也给最低支持的 App 版本", async () => {
    const health = (await (await t.browser().get("/api/health")).json()) as Record<string, unknown>;
    expect(health).toHaveProperty("minAppVersion", null);
    expect(health).not.toHaveProperty("version");
  });
});
