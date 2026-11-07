import { randomInt } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { AppDeps } from "../app";
import { emailChanges, users } from "../db/schema";
import { hashSecret } from "./login-codes";

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

export const emailChangeErrors = {
  same_email: { status: 400, message: "新邮箱与当前邮箱相同" },
  email_taken: { status: 409, message: "该邮箱已被其他账户使用" },
  invalid_code: { status: 400, message: "验证码错误或已过期，请重新获取" },
} as const;

export type EmailChangeError = keyof typeof emailChangeErrors;

/** 换邮箱之前先查：新邮箱不能和现在的一样，也不能已经是别人的。 */
export async function checkNewEmail(
  deps: AppDeps,
  user: { email: string },
  newEmail: string,
): Promise<EmailChangeError | undefined> {
  if (newEmail === user.email) return "same_email";
  const [taken] = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, newEmail));
  return taken ? "email_taken" : undefined;
}

/** 换邮箱第一步：给新邮箱发验证码（先用 checkNewEmail 查过）。同一个账户之前没用掉的验证码作废。 */
export async function sendEmailChangeCode(
  deps: AppDeps,
  user: { id: string },
  newEmail: string,
): Promise<void> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const now = deps.clock.now();
  const row = {
    newEmail,
    codeHash: hashSecret(code),
    attempts: 0,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    createdAt: now,
  };
  await deps.db
    .insert(emailChanges)
    .values({ userId: user.id, ...row })
    .onConflictDoUpdate({ target: emailChanges.userId, set: row });
  await deps.mailer.send({
    to: newEmail,
    subject: "SeekCloud：确认新邮箱",
    text: `你正在将 SeekCloud 账户的邮箱更换为此地址。验证码：${code}，10 分钟内有效。\n\n如非本人操作，请忽略此邮件。`,
  });
}

/** 换邮箱第二步：验证码对了就换，并通知旧邮箱。最多试 5 次，和登录验证码一样。 */
export async function confirmEmailChange(
  deps: AppDeps,
  user: { id: string; email: string },
  code: string,
): Promise<{ ok: true; email: string } | { ok: false; error: EmailChangeError }> {
  const now = deps.clock.now();
  // 先占用一次机会再比对，同时到达的请求加起来也只能试 5 次。
  const [row] = await deps.db
    .update(emailChanges)
    .set({ attempts: sql`${emailChanges.attempts} + 1` })
    .where(
      and(
        eq(emailChanges.userId, user.id),
        lt(emailChanges.attempts, MAX_ATTEMPTS),
        sql`${emailChanges.expiresAt} > ${now}`,
      ),
    )
    .returning();
  if (!row || row.codeHash !== hashSecret(code)) return { ok: false, error: "invalid_code" };

  try {
    await deps.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(emailChanges)
        .where(and(eq(emailChanges.userId, user.id), eq(emailChanges.codeHash, row.codeHash)))
        .returning({ userId: emailChanges.userId });
      if (deleted.length === 0) throw new Error("验证码已经用过了");
      await tx.update(users).set({ email: row.newEmail }).where(eq(users.id, user.id));
    });
  } catch (error) {
    // 发验证码以后，这个邮箱被别人注册了（唯一约束）。
    if ((error as { cause?: { code?: string } }).cause?.code === "23505") {
      return { ok: false, error: "email_taken" };
    }
    if ((error as Error).message === "验证码已经用过了")
      return { ok: false, error: "invalid_code" };
    throw error;
  }

  // 通知旧邮箱。发不出去不影响换邮箱本身。
  await deps.mailer
    .send({
      to: user.email,
      subject: "SeekCloud：账户邮箱已更换",
      text: `你的 SeekCloud 账户邮箱已更换为 ${row.newEmail}。\n\n如非本人操作，请立即使用新邮箱登录核查，或与我们联系。`,
    })
    .catch((error: unknown) => console.error("换邮箱通知发送失败", error));
  return { ok: true, email: row.newEmail };
}
