import { and, eq, ne, sql } from "drizzle-orm";
import type { AppDeps } from "../app";
import type { Database } from "../db/client";
import { loginSessions, users } from "../db/schema";
import { createDefaultEnvironment } from "../environments";
import { hashPassword, randomPassword, verifyPassword } from "./password";

/**
 * 管理员：开源版只有这一个账户（ADR 0008）。首次设置密码时建 users 里的这一行和默认环境，
 * 会话、环境都挂在它下面。
 */

const SETUP_LOCK = 7_310_001;

/** 设置过管理员密码没有。 */
export async function hasAdmin(db: Database): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows.length > 0;
}

/** 首次设置密码：建管理员和默认环境，返回管理员的 ID。已经设置过时返回 undefined，什么都不改。 */
export async function setUpAdmin(
  deps: Pick<AppDeps, "db" | "clock">,
  password: string,
): Promise<string | undefined> {
  // 先便宜地看一眼：设置过以后再有人来设，不用花时间算哈希。
  if (await hasAdmin(deps.db)) return undefined;
  const passwordHash = await hashPassword(password);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    // 同时提交的几个设置一个个来，只有第一个能建成。
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
    if ((await tx.select({ id: users.id }).from(users).limit(1)).length > 0) return undefined;
    const [admin] = await tx
      .insert(users)
      .values({ passwordHash, createdAt: now })
      .returning({ id: users.id });
    const id = (admin as { id: string }).id;
    await createDefaultEnvironment(tx, id, now);
    return id;
  });
}

/** 密码正确时返回管理员的 ID。 */
export async function checkPassword(db: Database, password: string): Promise<string | undefined> {
  const [admin] = await db.select().from(users).limit(1);
  if (!admin || !(await verifyPassword(password, admin.passwordHash))) return undefined;
  return admin.id;
}

/** 换密码，同时让登录状态作废：keepTokenHash 对应的那个（当前设备）留着，其他的全删。 */
export async function setPassword(
  db: Database,
  userId: string,
  password: string,
  keepTokenHash?: string,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    await tx
      .delete(loginSessions)
      .where(
        keepTokenHash
          ? and(eq(loginSessions.userId, userId), ne(loginSessions.tokenHash, keepTokenHash))
          : eq(loginSessions.userId, userId),
      );
  });
}

/** 忘记密码时在服务器上重置：换成一个随机密码并返回它，所有设备退出。还没设置过时返回 undefined。 */
export async function resetAdminPassword(db: Database): Promise<string | undefined> {
  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) return undefined;
  const password = randomPassword();
  await setPassword(db, admin.id, password);
  return password;
}
