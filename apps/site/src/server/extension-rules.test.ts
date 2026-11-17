import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR 0010 的几条规矩，用读源码的办法守住：有人把扩展点绕过去写死时，这里失败。
 * 测试文件不查。
 */
const serverDir = import.meta.dirname;

async function sources(dir = serverDir): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(full)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push({ path: relative(serverDir, full), text: await readFile(full, "utf8") });
    }
  }
  return out;
}

const offenders = async (allowed: (path: string) => boolean, pattern: RegExp) =>
  (await sources()).filter((f) => !allowed(f.path) && pattern.test(f.text)).map((f) => f.path);

describe("扩展点的规矩", () => {
  it("接口不自己读登录状态，都经过 deps.identity：只有主干的身份来源（auth/）用 login-sessions", async () => {
    expect(
      await offenders((p) => p.startsWith("auth/"), /from "[./]*\/?auth\/login-sessions"/),
    ).toEqual([]);
  });

  it("除了 auth/admin.ts，没有“取库里唯一的那个管理员”的写法", async () => {
    expect(await offenders((p) => p === "auth/admin.ts", /\.from\(users\)\s*\.limit\(/)).toEqual(
      [],
    );
  });

  it("设置只经过 settings.ts 读写（默认值和能不能改要问规则）", async () => {
    expect(
      await offenders(
        (p) => p === "settings.ts" || p.startsWith("db/"),
        /\.(from|insert|update|delete)\(settings\)/,
      ),
    ).toEqual([]);
  });
});
