import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";

describe("错误返回", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("不存在的接口返回 404，带错误码和中文说明", async () => {
    const res = await t.request("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "接口不存在" },
    });
  });
});

describe("错误返回：请求本身有问题", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("JSON 写坏了：返回 400 和统一格式", async () => {
    const res = await t.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_request", message: "请求格式错误" },
    });
  });

  it("缺字段：说明是中文", async () => {
    const res = await t.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("invalid_request");
    expect(error.message).toMatch(/[一-鿿]/);
  });
});
