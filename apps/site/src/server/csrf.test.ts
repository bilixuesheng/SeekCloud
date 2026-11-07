import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";

describe("跨站请求防护", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("别的网站用表单发来的修改请求被拒绝", async () => {
    const res = await t.browser().request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: "",
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: "拒绝来自其他站点的请求" },
    });
  });

  it("本站发来的请求照常处理", async () => {
    const res = await t.browser().request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: "{}",
    });

    expect(res.status).toBe(204);
  });
});
