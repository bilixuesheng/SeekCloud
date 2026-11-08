import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/** 密码最长几位。再长的直接拒绝：免得有人提交超长的字符串，让 scrypt 白白占着 CPU。 */
export const MAX_PASSWORD_LENGTH = 256;

/** 存进数据库的写法：scrypt$盐$哈希（base64url）。每个密码一个随机盐，scrypt 用 Node 的默认参数。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length);
  // 比较的耗时和哪一位不同无关，不能靠计时一位位猜出哈希。
  return timingSafeEqual(actual, expected);
}

/** 重置密码时生成的随机密码：12 字节，写成 16 个字符。 */
export const randomPassword = () => randomBytes(12).toString("base64url");
