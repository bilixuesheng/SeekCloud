import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitObjectSigner, loadSigningKey, looksLikeGitObject, sshSign } from "./sshsig";

const pem = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

describe("SSH 签名（git 的 SSHSIG 格式）", () => {
  it("签出来的东西，真的 ssh-keygen 能验证通过；改一个字就不通过", () => {
    const key = loadSigningKey(pem, "seekcloud-bot");
    const dir = mkdtempSync(join(tmpdir(), "sshsig-"));
    const message = Buffer.from(`tree ${"a".repeat(40)}\nauthor x\n\n提交说明\n`);
    writeFileSync(join(dir, "msg"), message);
    writeFileSync(join(dir, "msg.sig"), sshSign(key, "git", message));
    writeFileSync(join(dir, "allowed"), `bot@seekcloud ${key.publicLine}\n`);

    const verify = (file: string) =>
      execFileSync(
        "ssh-keygen",
        [
          "-Y",
          "verify",
          "-f",
          join(dir, "allowed"),
          "-I",
          "bot@seekcloud",
          "-n",
          "git",
          "-s",
          join(dir, "msg.sig"),
        ],
        { input: Buffer.from(file === "msg" ? message : Buffer.from("tampered")) },
      ).toString();

    expect(verify("msg")).toContain("Good");
    expect(() => verify("tampered")).toThrow();
  });

  it("只签 git 的提交和标签对象", () => {
    expect(looksLikeGitObject(Buffer.from(`tree ${"a".repeat(40)}\nparent x\n`))).toBe(true);
    expect(looksLikeGitObject(Buffer.from(`object ${"b".repeat(40)}\ntype commit\n`))).toBe(true);
    expect(looksLikeGitObject(Buffer.from("SSH challenge"))).toBe(false);
  });

  it("读出提交者或打标签的人的邮箱（只看头部，不看提交说明）", () => {
    const commit = `tree ${"a".repeat(40)}\nauthor 甲 <a@x.com> 1 +0800\ncommitter 乙 <bot@seekcloud.test> 1 +0800\n\ncommitter 丙 <c@x.com>\n`;
    expect(gitObjectSigner(Buffer.from(commit))).toBe("bot@seekcloud.test");
    const tag = `object ${"b".repeat(40)}\ntype commit\ntag v1\ntagger 丁 <d@x.com> 1 +0800\n\nmsg\n`;
    expect(gitObjectSigner(Buffer.from(tag))).toBe("d@x.com");
    expect(gitObjectSigner(Buffer.from(`tree ${"a".repeat(40)}\n\ncommitter x <e@x.com>`))).toBe(
      undefined,
    );
  });

  it("不是 ed25519 的密钥不收", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    expect(() => loadSigningKey(rsa)).toThrow();
  });
});
