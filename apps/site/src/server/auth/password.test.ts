import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("密码哈希", () => {
  it("只存 scrypt 的哈希，不含原文；同一个密码每次的盐都不同", async () => {
    const first = await hashPassword("correct horse");
    const second = await hashPassword("correct horse");

    expect(first).toMatch(/^scrypt\$[\w-]+\$[\w-]+$/);
    expect(first).not.toContain("correct horse");
    expect(second).not.toBe(first);
  });

  it("密码正确才通过", async () => {
    const stored = await hashPassword("correct horse");

    expect(await verifyPassword("correct horse", stored)).toBe(true);
    expect(await verifyPassword("correct hors", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("超过 256 位：直接不通过，不去算哈希", async () => {
    const tooLong = "x".repeat(257);
    const stored = await hashPassword(tooLong);

    expect(await verifyPassword(tooLong, stored)).toBe(false);
    expect(await verifyPassword("y".repeat(256), await hashPassword("y".repeat(256)))).toBe(true);
  });

  it("存的值格式不对：不通过，也不报错", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$abc$def")).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc$")).toBe(false);
  });
});
