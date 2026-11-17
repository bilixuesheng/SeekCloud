import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "./test-browser";

/** 契约测试怎么操作一个身份来源。浏览器都来自同一个主站。 */
export interface IdentityDriver {
  /** 一个还没登录的浏览器（一台新设备）。 */
  browser(): TestBrowser;
  /** 让这个浏览器登录。每次登录的都是同一个人。返回同一个浏览器。 */
  logIn(browser: TestBrowser): Promise<TestBrowser>;
  /** 这个浏览器退出登录。 */
  logOut(browser: TestBrowser): Promise<void>;
  /**
   * 换凭据（比如改密码）：这个浏览器保持登录，同一个人的其他设备全部退出。
   * 身份来源没有凭据可换时不填，这一条跳过。
   */
  changeCredential?(browser: TestBrowser): Promise<void>;
}

/**
 * 扩展点"身份来源"的契约（ADR 0010）：主干的实现和下游的实现都要通过。
 * 只通过主站的公开接口检查，不看身份来源内部怎么存登录状态。
 *
 *   describeIdentityContract("管理员密码登录", async () => {
 *     const t = await createTestApp();
 *     return { driver: { ... }, close: t.close };
 *   });
 */
export function describeIdentityContract(
  name: string,
  setup: () => Promise<{ driver: IdentityDriver; close(): Promise<void> }>,
) {
  describe(`身份来源的契约：${name}`, () => {
    let driver: IdentityDriver;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ driver, close } = await setup());
    });
    afterAll(() => close());

    const whoIs = async (browser: TestBrowser) => {
      const res = await browser.get("/api/me");
      return res.status === 200 ? ((await res.json()) as { id: string }).id : res.status;
    };

    it("没登录时，要登录的接口一律回 401，事件流也连不上", async () => {
      const browser = driver.browser();
      expect(await whoIs(browser)).toBe(401);
      for (const path of ["/api/sessions", "/api/environments", "/api/sessions/stream"]) {
        const res = await browser.get(path);
        expect(res.status, path).toBe(401);
        expect((await res.json()).error.code, path).toBe("unauthorized");
      }
    });

    it("登录以后知道是谁；两台设备登录的是同一个人", async () => {
      const first = await driver.logIn(driver.browser());
      const second = await driver.logIn(driver.browser());
      const id = await whoIs(first);
      expect(typeof id).toBe("string");
      expect(await whoIs(second)).toBe(id);
      expect((await first.get("/api/sessions")).status).toBe(200);
    });

    it("退出以后，这台设备的登录状态在服务器上也失效了；别的设备不受影响", async () => {
      const leaving = await driver.logIn(driver.browser());
      const other = await driver.logIn(driver.browser());
      // 退出之前留一份 Cookie：退出只删浏览器里的 Cookie、服务器还认的话，拿着旧 Cookie 还能进来。
      const stolen = leaving.clone();

      await driver.logOut(leaving);

      expect(await whoIs(leaving)).toBe(401);
      expect(await whoIs(stolen)).toBe(401);
      expect((await stolen.get("/api/sessions/stream")).status).toBe(401);
      expect(typeof (await whoIs(other))).toBe("string");
    });

    it("换凭据以后，这台设备还登录着，其他设备全部退出", async (ctx) => {
      if (!driver.changeCredential) return ctx.skip();
      const changing = await driver.logIn(driver.browser());
      const other = await driver.logIn(driver.browser());

      await driver.changeCredential(changing);

      expect(typeof (await whoIs(changing))).toBe("string");
      expect(await whoIs(other)).toBe(401);
    });
  });
}
