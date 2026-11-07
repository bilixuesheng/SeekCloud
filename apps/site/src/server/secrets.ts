import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 用 AES-256-GCM 加密存进数据库或 Cookie 的敏感内容（令牌之类）。 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("加密密钥必须是 32 字节");
    this.#key = key;
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  /** 被改过或用别的密钥加密的内容返回 undefined。 */
  open(sealed: string): string | undefined {
    try {
      const raw = Buffer.from(sealed, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      return undefined;
    }
  }
}
