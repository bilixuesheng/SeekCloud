import { describe, expect, it } from "vitest";
import { maskKey, redactSecrets } from "./mask";

describe("已保存的 key 的脱敏预览（照 dsh 的 maskCredential）", () => {
  const dots = (n: number) => "•".repeat(n);
  it.each([
    // 标识（第一个 - 或 _ 之前，连同符号）+ 前五个 + 中间至少藏八个 + 后四个
    ["sk-0123456789abcdefWXYZ", `sk-01234${dots(11)}WXYZ`],
    ["sk_live_0123456789abcdef", `sk_live_${dots(12)}cdef`],
    // 没有 - 或 _：前五个、后四个
    ["AIzaSyA0123456789abcdefgh", `AIzaS${dots(16)}efgh`],
    // 中间藏不到八个：整串都是点
    ["sk-0123456789abcd", dots(17)],
    ["short", dots(5)],
    ["", ""],
    // 按 Unicode 码点算，长度不变
    ["密钥-甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未", `密钥-甲乙丙丁戊${dots(9)}辰巳午未`],
    ["密钥-甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳", dots(19)],
    ["😀-0123456789abcdefgh", `😀-01234${dots(9)}efgh`],
  ])("%j → %j", (key, masked) => {
    expect(maskKey(key)).toBe(masked);
    expect(Array.from(maskKey(key))).toHaveLength(Array.from(key).length);
  });

  it("正好藏八个时给预览，藏七个时全是点", () => {
    expect(maskKey("ab-12345678901234567")).toBe(`ab-12345${"•".repeat(8)}4567`);
    expect(maskKey("ab-1234567890123456")).toBe("•".repeat(19));
  });
});

describe("报错里的密钥打码", () => {
  it("这次用的 key、常见格式的 key、Bearer 后面的都打码，别的文字不动", () => {
    const key = "custom-key-value-12345";
    const out = redactSecrets(
      `401: invalid key ${key}; also sk-abcdefghijklmnop and Authorization: Bearer abc.def.ghi-jkl; model gpt-4o`,
      key,
    );
    expect(out).not.toContain(key);
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).not.toContain("abc.def.ghi-jkl");
    expect(out).toContain("model gpt-4o");
    expect(out).toContain("401: invalid key");
  });
});
