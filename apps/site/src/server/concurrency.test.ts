import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";

// 同时到达的请求不能绕过限制。

describe("并发：首次设置", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("4 个浏览器同时设置管理员密码：只有 1 个成功，只建了 1 个默认环境", async () => {
    const browsers = Array.from({ length: 4 }, () => t.browser());

    const results = await Promise.all(
      browsers.map((browser, i) =>
        browser.post("/api/auth/setup", { password: `password-${i}`, nickname: "管理员" }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([204, 409, 409, 409]);
    const winner = browsers[results.findIndex((r) => r.status === 204)];
    const envs = (await (await winner?.get("/api/environments"))?.json()) as {
      environments: unknown[];
    };
    expect(envs.environments).toHaveLength(1);
  });
});

describe("并发：输错密码", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await t.admin();
  });
  afterAll(() => t.close());

  it("同一个 IP 同时猜 30 次密码：最多 10 次真的去比对，之后正确的密码也被暂停", async () => {
    const browser = t.browser();

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        browser.post("/api/auth/login", { password: `guess-${i}` }),
      ),
    );

    expect(results.filter((r) => r.status === 400)).toHaveLength(10);
    expect(results.filter((r) => r.status === 429)).toHaveLength(20);
    expect((await browser.post("/api/auth/login", { password: t.adminPassword })).status).toBe(429);
  });
});
