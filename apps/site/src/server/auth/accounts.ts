import { LEGAL_VERSION } from "@seekcloud/protocol";
import { and, count, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { AppDeps } from "../app";
import type { Tx } from "../db/client";
import { inviteCodes, loginCodes, users } from "../db/schema";
import { createDefaultEnvironment } from "../environments";
import { normalizeInviteCode } from "./invites";
import { hashSecret } from "./login-codes";

const MAX_ATTEMPTS = 5;
const REGISTRATION_LOCK = 7_310_001;

export const accountErrors = {
  invalid_code: { status: 400, message: "验证码错误或已过期" },
  invite_required: { status: 400, message: "该邮箱尚未注册，请填写邀请码" },
  invite_invalid: { status: 400, message: "邀请码无效" },
  invite_used: { status: 400, message: "该邀请码已被使用" },
  invite_expired: { status: 400, message: "该邀请码已过期" },
  seats_full: { status: 403, message: "内测名额已满" },
  email_taken: {
    status: 409,
    message: "该邮箱已注册。请先登录该账户，再进行绑定",
  },
  identity_taken: { status: 409, message: "该账号已绑定其他 SeekCloud 账户" },
  already_linked: {
    status: 409,
    message: "当前账户已绑定同类账号，请先在设置中解绑",
  },
  terms_required: { status: 400, message: "请先阅读并同意用户协议和隐私政策" },
  no_email: {
    status: 400,
    message: "该账号没有已验证的邮箱，无法用于注册。可先登录已有账户，再进行绑定",
  },
  pending_expired: { status: 400, message: "授权已过期，请重新登录" },
} as const;

export type AccountError = keyof typeof accountErrors;

export type VerifyResult =
  | { ok: true; userId: string; registered: boolean }
  | { ok: false; error: AccountError };

/** 在事务里抛出它，事务回滚，调用方拿到对应的错误码。 */
export class Abort extends Error {
  constructor(readonly reason: AccountError) {
    super(reason);
  }
}

/** 跑一个可能用 Abort 中止的事务。 */
export async function inTransaction<T>(
  deps: AppDeps,
  work: (tx: Tx) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: AccountError }> {
  try {
    return { ok: true, value: await deps.db.transaction(work) };
  } catch (error) {
    if (error instanceof Abort) return { ok: false, error: error.reason };
    throw error;
  }
}

/** 拿注册用的事务锁：注册一个个来，内测席位和邮箱、身份的唯一性检查不会被同时注册的人绕过。 */
export async function lockRegistrations(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${REGISTRATION_LOCK})`);
}

/** 注册新账户：检查内测席位和邀请码，建账户和默认环境，返回用户 ID。 */
export async function registerAccount(
  tx: Tx,
  deps: AppDeps,
  input: { email: string; inviteCode?: string; acceptTerms?: boolean; now: Date },
): Promise<string> {
  const { now } = input;
  await lockRegistrations(tx);
  const [seats] = await tx.select({ taken: count() }).from(users);
  if ((seats?.taken ?? 0) >= deps.seatLimit) throw new Abort("seats_full");

  if (!input.inviteCode) throw new Abort("invite_required");
  // 只在真的要建账户时检查：老用户登录不用再同意一次。
  if (input.acceptTerms !== true) throw new Abort("terms_required");

  const [user] = await tx
    .insert(users)
    .values({
      email: input.email,
      createdAt: now,
      termsVersion: LEGAL_VERSION,
      termsAcceptedAt: now,
    })
    .returning({ id: users.id });
  const userId = (user as { id: string }).id;

  const code = normalizeInviteCode(input.inviteCode);
  const claimed = await tx
    .update(inviteCodes)
    .set({ usedBy: userId, usedAt: now })
    .where(
      and(
        eq(inviteCodes.code, code),
        isNull(inviteCodes.usedAt),
        or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
      ),
    )
    .returning({ id: inviteCodes.id });
  if (claimed.length === 0) {
    const [invite] = await tx.select().from(inviteCodes).where(eq(inviteCodes.code, code));
    throw new Abort(!invite ? "invite_invalid" : invite.usedAt ? "invite_used" : "invite_expired");
  }

  await createDefaultEnvironment(tx, userId, now);
  return userId;
}

/**
 * 校验邮箱验证码。邮箱已有账户就登录；没有就用邀请码注册，并建默认环境。
 * 缺邀请码或邀请码有问题时，验证码不作废，用户补上邀请码可以接着用。
 */
export async function verifyEmailLogin(
  deps: AppDeps,
  input: { email: string; code: string; inviteCode?: string; acceptTerms?: boolean },
): Promise<VerifyResult> {
  const { db } = deps;
  const now = deps.clock.now();

  const [pending] = await db
    .select()
    .from(loginCodes)
    .where(
      and(
        eq(loginCodes.email, input.email),
        isNull(loginCodes.consumedAt),
        gt(loginCodes.expiresAt, now),
      ),
    )
    .orderBy(desc(loginCodes.createdAt))
    .limit(1);
  if (!pending) return { ok: false, error: "invalid_code" };

  // 先占用一次校验机会再比对。这一步是原子的，同时到达的请求加起来也只能用掉 5 次。
  const [attempt] = await db
    .update(loginCodes)
    .set({ attempts: sql`${loginCodes.attempts} + 1` })
    .where(
      and(
        eq(loginCodes.id, pending.id),
        isNull(loginCodes.consumedAt),
        lt(loginCodes.attempts, MAX_ATTEMPTS),
      ),
    )
    .returning({ id: loginCodes.id });
  if (!attempt || pending.codeHash !== hashSecret(input.code)) {
    return { ok: false, error: "invalid_code" };
  }

  const result = await inTransaction(deps, async (tx) => {
    const consumed = await tx
      .update(loginCodes)
      .set({ consumedAt: now })
      .where(and(eq(loginCodes.id, pending.id), isNull(loginCodes.consumedAt)))
      .returning({ id: loginCodes.id });
    if (consumed.length === 0) throw new Abort("invalid_code");

    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email));
    if (existing) return { userId: existing.id, registered: false };

    const userId = await registerAccount(tx, deps, { ...input, now });
    return { userId, registered: true };
  });
  return result.ok ? { ok: true, ...result.value } : result;
}
