import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrlFor } from "../testing/database";
import { createTestApp, type TestApp } from "../testing/test-app";

describe("健康检查", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ version: "1.2.3", now: new Date("2026-11-01T08:00:00Z") });
  });
  afterAll(() => t.close());

  it("返回版本号、数据库状态和当前时间", async () => {
    const res = await t.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      version: "1.2.3",
      database: "ok",
      time: "2026-11-01T08:00:00.000Z",
    });
  });

  it("时间跟着时钟走", async () => {
    t.clock.advance(90_000);

    const res = await t.request("/api/health");

    expect((await res.json()).time).toBe("2026-11-01T08:01:30.000Z");
  });
});

describe("健康检查：数据库连不上", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ databaseUrl: databaseUrlFor("seekcloud_test_does_not_exist") });
  });
  afterAll(() => t.close());

  it("返回 503，并标明数据库出错", async () => {
    const res = await t.request("/api/health");

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "error", database: "error" });
  });
});
