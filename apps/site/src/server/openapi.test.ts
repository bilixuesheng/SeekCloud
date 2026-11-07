import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";

describe("OpenAPI 描述", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ version: "1.2.3" });
  });
  afterAll(() => t.close());

  it("由路由定义生成，包含健康检查接口", async () => {
    const res = await t.request("/api/openapi.json");

    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.2.3");
    expect(doc.paths["/api/health"].get.responses).toHaveProperty("200");
    expect(doc.paths["/api/health"].get.responses).toHaveProperty("503");
  });
});
