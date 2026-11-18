import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { hosts } from "../db/schema";

/** 宿主机密钥的前缀，方便在日志、配置文件里认出来（密钥本身不进日志）。 */
const PREFIX = "schk_";

/** 宿主机的名字：小写字母、数字和连字符，1–40 个字，管理员在命令行和运行状况里认它。 */
export const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const hashHostKey = (key: string): string => createHash("sha256").update(key).digest("hex");

export type CreateHostResult =
  | { ok: true; id: string; key: string }
  | { ok: false; error: "invalid_name" | "name_taken" };

/**
 * 添加一台宿主机：生成 32 字节的随机密钥，库里只存它的哈希。密钥只在这里返回一次，调用方打印给管理员，不写日志。
 */
export async function createHost(db: Database, name: string, now: Date): Promise<CreateHostResult> {
  if (!HOST_NAME.test(name)) return { ok: false, error: "invalid_name" };
  const key = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(hosts)
    .values({ name, keyHash: hashHostKey(key), createdAt: now })
    .onConflictDoNothing({ target: hosts.name })
    .returning({ id: hosts.id });
  if (!row) return { ok: false, error: "name_taken" };
  return { ok: true, id: row.id, key };
}

/** 吊销：这把密钥以后连不上，已有的连接由 HostHub 断开。返回吊销了没有（没有这台、早就吊销了都是 false）。 */
export async function revokeHost(db: Database, name: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(hosts)
    .set({ revokedAt: now })
    .where(and(eq(hosts.name, name), isNull(hosts.revokedAt)))
    .returning({ id: hosts.id });
  return rows.length > 0;
}

/**
 * 按密钥找宿主机；没有、已吊销都返回 undefined（调用方不区分两种情况）。
 * 按哈希查：密钥是 32 字节的随机数，查库和比较的耗时只和哈希有关，从耗时上推不出密钥。比较时仍用定长比较。
 */
export async function findHostByKey(db: Database, key: string) {
  if (!key.startsWith(PREFIX) || key.length > 200) return undefined;
  const hash = hashHostKey(key);
  const [row] = await db
    .select()
    .from(hosts)
    .where(and(eq(hosts.keyHash, hash), isNull(hosts.revokedAt)));
  if (!row || !timingSafeEqual(Buffer.from(row.keyHash), Buffer.from(hash))) return undefined;
  return row;
}
