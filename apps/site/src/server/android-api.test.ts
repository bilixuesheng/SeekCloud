import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";

/**
 * 安卓 App 的接口文档（#203）：主站的 /api/openapi.json 去掉 App 不用的接口，存在 apps/android/api/openapi.json，
 * App 构建时从它生成 Kotlin 接口代码（apps/android/app/build.gradle.kts 的 openApiGenerate）。
 * 主站的接口变了而没重新导出时这个测试失败。重新导出：在仓库根目录运行 pnpm --filter @seekcloud/site openapi:export
 */
const FILE = fileURLToPath(new URL("../../../android/api/openapi.json", import.meta.url));
const EXPORT = "pnpm --filter @seekcloud/site openapi:export";

/** App 不用的接口（路径本身和它下面的都去掉），每一项写明为什么。 */
const APP_SKIPS = [
  // 通行密钥（WebAuthn）只在网页上用：App 登录用密码和两步验证（#205）
  "/api/auth/passkeys",
  // 首次设置只在网页上做：App 连上还没设置密码的主站时，提示先去网页上设置（#205）
  "/api/auth/setup",
];

const skipped = (path: string) => APP_SKIPS.some((p) => path === p || path.startsWith(`${p}/`));

describe("安卓 App 的接口文档", () => {
  let t: TestApp;
  beforeAll(async () => {
    // 版本号写死：文档跟着主站的版本号变的话，每次发版都要重新导出
    t = await createTestApp({ version: "0" });
  });
  afterAll(() => t.close());

  it("和主站的接口一致（去掉 App 不用的）", async () => {
    const doc = (await (await t.request("/api/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    for (const path of Object.keys(doc.paths)) if (skipped(path)) delete doc.paths[path];
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env.UPDATE_ANDROID_API) writeFileSync(FILE, text);
    expect(
      readFileSync(FILE, "utf8") === text,
      `主站的接口文档变了，安卓 App 的那份没有重新导出：在仓库根目录运行 ${EXPORT}`,
    ).toBe(true);
  });

  it("不用的接口都还在主站上：改了路径要一起改这张清单", async () => {
    const doc = (await (await t.request("/api/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    for (const prefix of APP_SKIPS) {
      expect(
        Object.keys(doc.paths).some((p) => p === prefix || p.startsWith(`${prefix}/`)),
        prefix,
      ).toBe(true);
    }
  });
});
