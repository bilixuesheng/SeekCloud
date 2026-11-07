import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPEN_SOURCE } from "./licenses";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** 主站和宿主机运行时直接依赖的包（不含我们自己的 workspace 包）。 */
function runtimeDependencies(app: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "apps", app, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.entries(manifest.dependencies ?? {})
    .filter(([, version]) => !version.startsWith("workspace:"))
    .map(([name]) => name);
}

/** 装好的包自己写的许可证。pnpm 把每个应用的依赖链接在它自己的 node_modules 下。 */
function installedLicense(name: string): string {
  for (const app of ["site", "host"]) {
    const path = join(root, "apps", app, "node_modules", name, "package.json");
    if (existsSync(path)) {
      return (JSON.parse(readFileSync(path, "utf8")) as { license?: string }).license ?? "";
    }
  }
  return "（没有装）";
}

describe("开源声明", () => {
  it("主站和宿主机的每个运行时依赖都列在开源声明里", () => {
    const listed = new Set(OPEN_SOURCE.flatMap((item) => item.packages));
    const missing = [...runtimeDependencies("site"), ...runtimeDependencies("host")].filter(
      (name) => !listed.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("列出的许可证和包里写的一致", () => {
    const mismatched = OPEN_SOURCE.flatMap((item) =>
      item.packages
        .filter((name) => installedLicense(name) !== item.license)
        .map((name) => `${name}: 写的是 ${item.license}，包里是 ${installedLicense(name)}`),
    );
    expect(mismatched).toEqual([]);
  });

  it("按 MIT 许可证的要求列出 DeepSeek Harness 和它的版权声明", () => {
    expect(OPEN_SOURCE).toContainEqual(
      expect.objectContaining({
        name: "DeepSeek Harness",
        license: "MIT",
        copyright: "Copyright (c) 2026 DeepSeek",
      }),
    );
  });
});
