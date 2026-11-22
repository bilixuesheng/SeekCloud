import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  timeStep,
  totpCode,
} from "./totp";

/** RFC 6238 附录 B 的密钥（ASCII "12345678901234567890"），SHA1。 */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("base32 来回一致；RFC 的密钥编出来是标准写法", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")?.toString()).toBe(
      "12345678901234567890",
    );
    expect(base32Decode("GEZ1")).toBeUndefined();
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("验证码和 RFC 6238 的测试向量一致（8 位的后 6 位）", () => {
    const at = (seconds: number) => timeStep(new Date(seconds * 1000));
    expect(totpCode(RFC_SECRET, at(59))).toBe("287082");
    expect(totpCode(RFC_SECRET, at(1111111109))).toBe("081804");
    expect(totpCode(RFC_SECRET, at(1234567890))).toBe("005924");
    expect(totpCode(RFC_SECRET, at(2000000000))).toBe("279037");
  });

  it("前后各容许一个时间步；用过的时间步和更早的不再认；格式不对的不认", () => {
    const now = new Date(1111111109 * 1000);
    const step = timeStep(now);
    const code = totpCode(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, code, now, null)).toBe(step);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now, null)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, code, now, step)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, step - 1)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, ` ${code.slice(0, 3)} ${code.slice(3)} `, now, null)).toBe(step);
    expect(matchTotp(RFC_SECRET, "12345", now, null)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, "abcdef", now, null)).toBeUndefined();
  });

  it("二维码地址：发行方、账户名、密钥和参数", () => {
    const url = new URL(otpauthUrl("ABCDEF", "seekcloud.example.com"));
    expect(url.protocol).toBe("otpauth:");
    expect(url.host).toBe("totp");
    expect(decodeURIComponent(url.pathname)).toBe("/SeekCloud:seekcloud.example.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      secret: "ABCDEF",
      issuer: "SeekCloud",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    });
  });
});

describe("恢复码", () => {
  it("10 个、互不相同、写成 xxxxx-xxxxx；输入时不计较大小写、空格和连字符", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[2-9a-z]{5}-[2-9a-z]{5}$/);
    const first = codes[0] as string;
    expect(normalizeRecoveryCode(` ${first.toUpperCase().replace("-", " ")} `)).toBe(
      first.replace("-", ""),
    );
    expect(normalizeRecoveryCode("123456")).toBeUndefined();
    expect(normalizeRecoveryCode("abcde-fghi0")).toBeUndefined();
    expect(hashRecoveryCode("abcdefghjk")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode("abcdefghjk")).not.toBe(hashRecoveryCode("abcdefghjm"));
  });
});
