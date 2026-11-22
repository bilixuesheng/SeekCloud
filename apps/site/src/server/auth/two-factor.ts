import { and, count, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { AppDeps } from "../app";
import { recoveryCodes, users } from "../db/schema";
import {
  hashRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
} from "./totp";

/**
 * 两步验证（#100 的 TOTP 部分）：开启、核对、关闭、恢复码。
 *
 * - 密钥用 SecretBox 加密存在 users 里；开启前的密钥不进库，放在一个加密的设置令牌里交给浏览器，输对一次验证码才存；
 * - 同一个验证码不能用两次：记下用过的时间步，只认更晚的（原子地更新，两个请求同时拿同一个验证码也只有一个成功）；
 * - 恢复码 10 个，只显示一次，库里只存哈希，每个用一次。
 */

export type TwoFactorDeps = Pick<AppDeps, "db" | "clock" | "secrets">;

/** 密码对了、等着输验证码的中间状态，和开启时的设置令牌，都是 5 分钟。 */
export const PENDING_TTL_MS = 5 * 60_000;

export interface TwoFactorState {
  enabled: boolean;
  /** 还没用过的恢复码。 */
  recoveryCodesLeft: number;
}

export async function twoFactorState(
  deps: Pick<AppDeps, "db">,
  userId: string,
): Promise<TwoFactorState> {
  const [user] = await deps.db
    .select({ enabledAt: users.totpEnabledAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.enabledAt) return { enabled: false, recoveryCodesLeft: 0 };
  const [left] = await deps.db
    .select({ n: count() })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return { enabled: true, recoveryCodesLeft: left?.n ?? 0 };
}

export async function twoFactorEnabled(deps: Pick<AppDeps, "db">, userId: string) {
  return (await twoFactorState(deps, userId)).enabled;
}

/** 加密的短时令牌：登录的中间状态（login）和开启时的设置令牌（setup）。用途写在里面，不能混用。 */
type Pending =
  | { purpose: "login"; userId: string; client?: "app"; deviceName?: string }
  | { purpose: "setup"; userId: string; secret: string };

export function sealPending(deps: TwoFactorDeps, pending: Pending): string {
  return deps.secrets.seal(
    JSON.stringify({ ...pending, expiresAt: deps.clock.now().getTime() + PENDING_TTL_MS }),
  );
}

/** 打开令牌：被改过、过期了、用途不对时返回 undefined。 */
export function openPending<P extends Pending["purpose"]>(
  deps: TwoFactorDeps,
  token: string,
  purpose: P,
): Extract<Pending, { purpose: P }> | undefined {
  const plain = deps.secrets.open(token);
  if (!plain) return undefined;
  try {
    const value = JSON.parse(plain) as Pending & { expiresAt: number };
    if (value.purpose !== purpose || value.expiresAt <= deps.clock.now().getTime())
      return undefined;
    return value as unknown as Extract<Pending, { purpose: P }>;
  } catch {
    return undefined;
  }
}

/** 开启的第一步：新的密钥。 */
export function startTotpSetup(deps: TwoFactorDeps, userId: string) {
  const secret = newTotpSecret();
  return { secret, setupToken: sealPending(deps, { purpose: "setup", userId, secret }) };
}

/**
 * 开启的第二步：设置令牌里的密钥配上一个对的验证码才存，同时换一套新的恢复码。
 * 返回恢复码（只这一次）；验证码不对返回 "wrong_code"；已经开着时返回 "already_enabled"。
 */
export async function enableTotp(
  deps: TwoFactorDeps,
  userId: string,
  secret: string,
  code: string,
): Promise<string[] | "wrong_code" | "already_enabled"> {
  const now = deps.clock.now();
  const step = matchTotp(secret, code, now, null);
  if (step === undefined) return "wrong_code";
  const codes = newRecoveryCodes();
  const done = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ totpSecret: deps.secrets.seal(secret), totpEnabledAt: now, totpLastStep: step })
      .where(and(eq(users.id, userId), isNull(users.totpEnabledAt)))
      .returning({ id: users.id });
    if (!updated) return false;
    await replaceRecoveryCodes(tx, userId, codes, now);
    return true;
  });
  return done ? codes : "already_enabled";
}

type Tx = Parameters<Parameters<AppDeps["db"]["transaction"]>[0]>[0];

async function replaceRecoveryCodes(
  tx: Tx | AppDeps["db"],
  userId: string,
  codes: string[],
  now: Date,
): Promise<void> {
  await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await tx.insert(recoveryCodes).values(
    codes.map((code) => ({
      userId,
      codeHash: hashRecoveryCode(normalizeRecoveryCode(code) as string),
      createdAt: now,
    })),
  );
}

/**
 * 核对第二步：6 位数字按验证码核对，别的按恢复码核对。对上了就记下（验证码记时间步，恢复码记用过），返回 true。
 * 没开两步验证时返回 false。
 */
export async function verifySecondFactor(
  deps: TwoFactorDeps,
  userId: string,
  input: string,
): Promise<boolean> {
  const [user] = await deps.db
    .select({
      secret: users.totpSecret,
      enabledAt: users.totpEnabledAt,
      lastStep: users.totpLastStep,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.enabledAt || !user.secret) return false;
  const now = deps.clock.now();
  if (/^\s*\d{3}\s?\d{3}\s*$/.test(input)) {
    const secret = deps.secrets.open(user.secret);
    if (!secret) return false;
    const step = matchTotp(secret, input, now, user.lastStep);
    if (step === undefined) return false;
    // 两个请求同时拿同一个验证码来：只有先更新的那个算数
    const [claimed] = await deps.db
      .update(users)
      .set({ totpLastStep: step })
      .where(
        and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
      )
      .returning({ id: users.id });
    return Boolean(claimed);
  }
  const normalized = normalizeRecoveryCode(input);
  if (!normalized) return false;
  const [used] = await deps.db
    .update(recoveryCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id });
  return Boolean(used);
}

/** 关闭：清掉密钥和恢复码。原来开着时返回 true。 */
export async function disableTotp(deps: Pick<AppDeps, "db">, userId: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
      .where(and(eq(users.id, userId), isNotNull(users.totpEnabledAt)))
      .returning({ id: users.id });
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    return Boolean(updated);
  });
}

/** 重新生成恢复码：旧的全部作废。 */
export async function regenerateRecoveryCodes(
  deps: Pick<AppDeps, "db" | "clock">,
  userId: string,
): Promise<string[]> {
  const codes = newRecoveryCodes();
  await deps.db.transaction((tx) => replaceRecoveryCodes(tx, userId, codes, deps.clock.now()));
  return codes;
}
