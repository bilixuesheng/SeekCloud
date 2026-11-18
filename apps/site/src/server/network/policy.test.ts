import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWLIST, matchesDomain, normalizeHost } from "./policy";

describe("域名匹配（#47 的规则）", () => {
  it.each([
    ["*.example.com", "a.example.com", true],
    ["*.example.com", "a.b.example.com", true],
    ["*.example.com", "example.com", false],
    ["*.example.com", "example.com.evil.net", false],
    ["*.example.com", "evilexample.com", false],
    ["*.example.com", "a.example.com.", true],
    ["*.Example.COM.", "A.example.com", true],
    ["example.com", "EXAMPLE.com.", true],
    ["example.com", "www.example.com", false],
    ["example.com", "example.com.evil.net", false],
    ["example.com", "example.com/evil", false],
    ["example.com", "", false],
    ["例子.测试", "xn--fsqu00a.xn--0zwm56d", true],
  ] as const)("%s 对 %s：%s", (pattern, host, expected) => {
    expect(matchesDomain(pattern, host)).toBe(expected);
  });

  it("域名规整：小写、去掉末尾的点；带路径、@、空白的不是域名", () => {
    expect(normalizeHost("WWW.Example.COM.")).toBe("www.example.com");
    for (const bad of ["a/b", "a@b", "a b", "", "."])
      expect(normalizeHost(bad), bad).toBeUndefined();
  });

  it("默认清单里每一条都是合法的写法", () => {
    for (const entry of DEFAULT_ALLOWLIST) {
      const base = entry.startsWith("*.") ? entry.slice(2) : entry;
      expect(normalizeHost(base), entry).toBe(base);
    }
  });
});
