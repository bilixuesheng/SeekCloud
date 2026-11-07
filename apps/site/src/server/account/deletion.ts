import { randomInt } from "node:crypto";
import { rm } from "node:fs/promises";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { detachAccessLogs } from "../access-log";
import type { AppDeps } from "../app";
import { hashSecret } from "../auth/login-codes";
import {
  accountDeletionCodes,
  dataExports,
  emailChanges,
  githubTokens,
  identities,
  loginSessions,
  users,
} from "../db/schema";
import type { Sessions } from "../sessions/sessions";
import { exportFile } from "./exports";

/**
 * 删除账户：
 * - 邮箱验证码确认后立即停用：退出所有设备，解绑 GitHub 和 Google、删掉令牌，会话全部停下并删沙箱；
 * - 邮箱换成占位，原来的邮箱、GitHub 和 Google 账号马上可以重新注册（还是要邀请码）；
 * - 剩下的数据（会话、环境、导出）由清理任务在 PURGE_AFTER 之后整个删掉，在承诺的 15 天之内；
 * - 不调用任何会改动 GitHub 的接口：GitHub 上的分支和 PR 不动，令牌只是从我们这边删掉，几小时内自己过期。
 * - 访问记录（IP）要按《网络安全法》留存满 180 天：不删，断开和账户的关联，到期由清理任务删掉；
 * 被封禁的用户删除账户时把身份摘要留进黑名单，等暂停和封禁做了再加。
 */
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
export const PURGE_AFTER_MS = 14 * 24 * 60 * 60_000;

/** 第一步：给账户邮箱发验证码。之前没用掉的作废。 */
export async function sendDeletionCode(
  deps: AppDeps,
  user: { id: string; email: string },
): Promise<void> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const now = deps.clock.now();
  const row = {
    codeHash: hashSecret(code),
    attempts: 0,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    createdAt: now,
  };
  await deps.db
    .insert(accountDeletionCodes)
    .values({ userId: user.id, ...row })
    .onConflictDoUpdate({ target: accountDeletionCodes.userId, set: row });
  await deps.mailer.send({
    to: user.email,
    subject: "SeekCloud：确认删除账户",
    text: [
      `你正在删除 SeekCloud 账户 ${user.email}。验证码：${code}，10 分钟内有效。`,
      "",
      "账户删除后不可恢复，所有对话和设置将被彻底删除；GitHub 上的分支和 PR 不受影响。",
      "",
      "如非本人操作，请勿向任何人透露此验证码，并在设置中选择“在所有设备上退出”。",
    ].join("\n"),
  });
}

/** 第二步：验证码对了就停用账户。最多试 5 次。 */
export async function confirmDeletion(
  deps: AppDeps,
  sessions: Sessions,
  user: { id: string; email: string },
  code: string,
): Promise<{ ok: true } | { ok: false; error: "invalid_code" }> {
  const now = deps.clock.now();
  // 先占用一次机会再比对，同时到达的请求加起来也只能试 5 次。
  const [row] = await deps.db
    .update(accountDeletionCodes)
    .set({ attempts: sql`${accountDeletionCodes.attempts} + 1` })
    .where(
      and(
        eq(accountDeletionCodes.userId, user.id),
        lt(accountDeletionCodes.attempts, MAX_ATTEMPTS),
        sql`${accountDeletionCodes.expiresAt} > ${now}`,
      ),
    )
    .returning();
  if (!row || row.codeHash !== hashSecret(code)) return { ok: false, error: "invalid_code" };

  const deleted = await deps.db.transaction(async (tx) => {
    const used = await tx
      .delete(accountDeletionCodes)
      .where(eq(accountDeletionCodes.userId, user.id))
      .returning({ userId: accountDeletionCodes.userId });
    if (used.length === 0) return false;
    await tx
      .update(users)
      // 占位邮箱不是合法地址，不会和真实邮箱撞上，也收不到信。
      .set({ deletedAt: now, email: `deleted-${user.id}@deleted.invalid` })
      .where(eq(users.id, user.id));
    await tx.delete(loginSessions).where(eq(loginSessions.userId, user.id));
    await tx.delete(identities).where(eq(identities.userId, user.id));
    await tx.delete(githubTokens).where(eq(githubTokens.userId, user.id));
    await tx.delete(emailChanges).where(eq(emailChanges.userId, user.id));
    // 访问记录要按法定期限留存，不跟着删，只断开和账户的关联
    await detachAccessLogs(tx, user.id);
    return true;
  });
  if (!deleted) return { ok: false, error: "invalid_code" };

  await sessions.closeAllForUser(user.id);
  await deps.mailer
    .send({
      to: user.email,
      subject: "SeekCloud：账户已删除",
      text: [
        `你的 SeekCloud 账户 ${user.email} 已删除，所有设备均已退出登录。`,
        "",
        "对话、环境等数据将在 15 天内彻底清除，且不可恢复。GitHub 上的分支和 PR 未作改动。",
        "该邮箱可重新注册（需邀请码）。",
        "",
        "如非本人操作，请立即与我们联系。",
      ].join("\n"),
    })
    .catch((error: unknown) => console.error("删除账户的通知没发出去", error));
  return { ok: true };
}

/** 清理任务：删掉停用满 PURGE_AFTER 的账户，连同它的会话、环境、导出（数据库里都是级联删除）。 */
export async function purgeDeletedAccounts(deps: AppDeps): Promise<number> {
  const due = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        isNotNull(users.deletedAt),
        lt(users.deletedAt, new Date(deps.clock.now().getTime() - PURGE_AFTER_MS)),
      ),
    );
  if (due.length === 0) return 0;
  const ids = due.map((u) => u.id);
  const files = await deps.db
    .select({ id: dataExports.id })
    .from(dataExports)
    .where(inArray(dataExports.userId, ids));
  for (const { id } of files) await rm(exportFile(deps, id), { force: true });
  await deps.db.delete(users).where(inArray(users.id, ids));
  return ids.length;
}
