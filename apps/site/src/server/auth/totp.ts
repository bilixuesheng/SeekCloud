import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

/**
 * 两步验证的验证码（TOTP，RFC 6238）和恢复码（#100）。只有算法，不碰数据库：
 * HMAC-SHA1、30 秒一个时间步、6 位，和常见的验证器 App（Google Authenticator、1Password、Microsoft Authenticator）一致。
 */

export const TOTP_PERIOD_SECONDS = 30;
const DIGITS = 6;
/** 前后各容许一个时间步：手机和服务器的时钟差几十秒也能用。 */
const DRIFT_STEPS = 1;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** 认不出的字符返回 undefined。空格、等号、大小写都不计较（有的 App 把密钥四个一组显示）。 */
export function base32Decode(text: string): Buffer | undefined {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 新的密钥：20 个随机字节（160 位，RFC 4226 建议的长度），base32。 */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function timeStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** 某个时间步的验证码。 */
export function totpCode(secret: string, step: number): string {
  const key = base32Decode(secret);
  if (!key) throw new Error("TOTP 密钥不是 base32");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * 核对验证码：对上了返回对上的时间步，没对上返回 undefined。
 * afterStep 是上次用过的时间步：同一个验证码（同一个时间步或更早的）不能再用。
 */
export function matchTotp(
  secret: string,
  code: string,
  at: Date,
  afterStep: number | null,
): number | undefined {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return undefined;
  const now = timeStep(at);
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
    if (afterStep !== null && step <= afterStep) continue;
    if (totpCode(secret, step) === digits) return step;
  }
  return undefined;
}

/** 验证器 App 扫的二维码里的地址。account 用来在 App 里区分几个部署（主站的域名）。 */
export function otpauthUrl(secret: string, account: string): string {
  const issuer = "SeekCloud";
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query}`;
}

export const RECOVERY_CODE_COUNT = 10;
/** 恢复码的字母表：去掉了容易看错的 0、1、i、l、o。 */
const RECOVERY_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** 10 个恢复码，写成 xxxxx-xxxxx（约 49 位随机）。 */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from(
      { length: 10 },
      () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)],
    ).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** 看起来像恢复码吗：去掉空格和连字符以后是 10 个字母表里的字符（不分大小写）。 */
export function normalizeRecoveryCode(input: string): string | undefined {
  const clean = input.replace(/[\s-]/g, "").toLowerCase();
  return /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/.test(clean) ? clean : undefined;
}

/** 库里只存哈希。恢复码本身是随机的，不用加盐慢哈希。 */
export function hashRecoveryCode(normalized: string): string {
  return createHash("sha256").update(`recovery:${normalized}`).digest("hex");
}
