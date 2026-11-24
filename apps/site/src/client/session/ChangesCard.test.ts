import { describe, expect, it } from "vitest";
import { shortPath } from "./ChangesCard";

describe("改动卡片上的文件名", () => {
  it("只写文件名", () => {
    expect(shortPath("apps/site/src/client/i18n/android.ts", [])).toBe("android.ts");
    expect(shortPath("package.json", ["package.json"])).toBe("package.json");
  });

  it("列出来的几个里有同名的，带上上一级目录", () => {
    const paths = ["apps/site/package.json", "apps/host/package.json", "README.md"];
    expect(shortPath("apps/site/package.json", paths)).toBe("site/package.json");
    expect(shortPath("apps/host/package.json", paths)).toBe("host/package.json");
    expect(shortPath("README.md", paths)).toBe("README.md");
  });
});
