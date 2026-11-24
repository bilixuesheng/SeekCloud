import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import { cameOverHttps, secureCookie } from "./https";

describe("登录 Cookie 的 Secure 按请求是不是经 HTTPS 来的定（#94）", () => {
  const check = async (url: string, headers: Record<string, string> = {}, forced = false) => {
    const app = new Hono().get("/", (c) =>
      c.json([cameOverHttps(c), secureCookie(c, { secureCookies: forced })]),
    );
    return (await app.request(url, { headers })).json();
  };

  it("https 地址、反向代理写的 X-Forwarded-Proto: https 算；主站对外的地址是 HTTPS 时总是带", async () => {
    expect(await check("http://seekcloud.test/")).toEqual([false, false]);
    expect(await check("https://seekcloud.test/")).toEqual([true, true]);
    expect(await check("http://seekcloud.test/", { "x-forwarded-proto": "https" })).toEqual([
      true,
      true,
    ]);
    // 几层代理时看最后一层写的
    expect(await check("http://seekcloud.test/", { "x-forwarded-proto": "https, http" })).toEqual([
      false,
      false,
    ]);
    expect(await check("http://seekcloud.test/", {}, true)).toEqual([false, true]);
  });

  describe("登录", () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp();
      await t.admin();
    });
    afterAll(() => t.close());

    const login = (headers: Record<string, string>) =>
      t.browser().request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ password: t.adminPassword }),
      });

    it("装好后先用 http://服务器地址 打开：Cookie 不带 Secure，浏览器存得下；经 HTTPS 时带", async () => {
      const plain = await login({});
      expect(plain.status).toBe(204);
      expect(plain.headers.getSetCookie().join("\n")).not.toMatch(/;\s*Secure/i);
      const secure = await login({ "x-forwarded-proto": "https" });
      expect(secure.headers.getSetCookie().join("\n")).toMatch(/;\s*Secure/i);
    });
  });
});
