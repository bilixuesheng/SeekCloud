import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWLIST, matchesDomain, normalizeHost, webFetchDecision } from "./policy";

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

describe("网页抓取按环境的网络策略判断（用户定之前照最保守的做）", () => {
  it("不开放：一律拒绝", () => {
    expect(webFetchDecision("none", "github.com").ok).toBe(false);
  });

  it("默认清单：只放行清单里的域名", () => {
    expect(webFetchDecision("default", "raw.githubusercontent.com").ok).toBe(true);
    expect(webFetchDecision("default", "registry.npmjs.org").ok).toBe(true);
    const denied = webFetchDecision("default", "example.com");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.message).toContain("example.com");
  });

  it("自定义：只放行环境自己的清单（现在还没地方填，是空的）", () => {
    expect(webFetchDecision("custom", "github.com").ok).toBe(false);
    expect(webFetchDecision("custom", "a.corp.example", ["*.corp.example"]).ok).toBe(true);
  });

  it("完全开放：不限（内网地址另外拦）", () => {
    expect(webFetchDecision("full", "example.com").ok).toBe(true);
  });
});
