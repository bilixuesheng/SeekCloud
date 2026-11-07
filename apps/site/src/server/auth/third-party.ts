import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDeps } from "../app";
import type { Tx } from "../db/client";
import { identities, pendingIdentities, users } from "../db/schema";
import type { GitHubTokens } from "../github/port";
import { saveGitHubTokens } from "../github/tokens";
import {
  Abort,
  type AccountError,
  inTransaction,
  lockRegistrations,
  registerAccount,
} from "./accounts";
import { currentUser, startLoginSession } from "./login-sessions";

/**
 * 第三方登录（GitHub）的规则：
 * - 一个 GitHub 账号最多属于一个账户；一个账户最多绑一个；
 * - 陌生的第三方账号：让用户选"创建新账户"（要邀请码）还是"登录已有账户再绑定"；
 * - 第三方的邮箱对上了已有账户：不自动合并，先登录那个账户，再由用户确认绑定；
 * - 登录以后绑定待处理的身份也要用户确认：公用电脑上前一个人授权过的账号，不能悄悄绑进下一个人的账户。
 */

export type Provider = "github";

export interface ThirdPartyIdentity {
  provider: Provider;
  /** 第三方那边不会变的用户 ID。 */
  subject: string;
  /** 显示用的名字：GitHub 的 login。 */
  login: string;
  /** 第三方确认过的邮箱；没有时为 null。 */
  email: string | null;
  githubTokens?: GitHubTokens;
}

const PENDING_COOKIE = "sc_pending";
const PENDING_PATH = "/api/auth";
const PENDING_TTL_S = 600;

/** 授权完成后可以回到的页面。只接受这几个，免得被拿去跳到别的网站。 */
const NEXT_PAGES = ["/", "/settings"] as const;
export type NextPage = (typeof NEXT_PAGES)[number];
export const parseNext = (value: string | undefined): NextPage =>
  NEXT_PAGES.find((page) => page === value) ?? "/";

/** 带上结果参数的回跳地址，比如 /settings?github=identity_taken。 */
const withResult = (next: NextPage, provider: Provider, result: string) =>
  `${next}?${provider}=${result}`;

type Db = Pick<AppDeps["db"], "select">;

function findIdentity(db: Db, provider: Provider, subject: string) {
  return db
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.provider, provider), eq(identities.subject, subject)))
    .then((rows) => rows[0]);
}

function hasProvider(db: Db, userId: string, provider: Provider) {
  return db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.userId, userId), eq(identities.provider, provider)))
    .then((rows) => rows.length > 0);
}

/** 在事务里把身份绑到账户上。身份已属于别人、账户已经有这种身份时中止。 */
async function bind(tx: Tx, deps: AppDeps, userId: string, identity: ThirdPartyIdentity) {
  const now = deps.clock.now();
  const owner = await findIdentity(tx, identity.provider, identity.subject);
  if (owner && owner.userId !== userId) throw new Abort("identity_taken");
  if (!owner) {
    if (await hasProvider(tx, userId, identity.provider)) throw new Abort("already_linked");
    await tx.insert(identities).values({
      userId,
      provider: identity.provider,
      subject: identity.subject,
      login: identity.login,
      createdAt: now,
    });
  }
  if (identity.githubTokens) {
    await saveGitHubTokens(tx, deps, userId, identity.githubTokens, now);
  }
}

/** 唯一约束冲突：同时有人把同一个身份绑到了别的账户。 */
const isUniqueViolation = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code === "23505";

/**
 * 第三方授权跳回来以后怎么办，返回要跳到的地址：
 * - 已登录：绑到当前账户（设置页里点"绑定"）；
 * - 没登录、身份已经绑过：直接登录；
 * - 没登录、陌生身份：存成待处理，让用户选怎么办。
 */
export async function finishThirdPartySignIn(
  deps: AppDeps,
  c: Context,
  identity: ThirdPartyIdentity,
  next: NextPage,
): Promise<string> {
  const me = await currentUser(deps, c);
  if (me) {
    const result = await inTransaction(deps, (tx) => bind(tx, deps, me.id, identity)).catch(
      (error: unknown) => {
        if (isUniqueViolation(error))
          return { ok: false as const, error: "identity_taken" as const };
        throw error;
      },
    );
    return result.ok ? next : withResult(next, identity.provider, result.error);
  }

  const owner = await findIdentity(deps.db, identity.provider, identity.subject);
  if (owner) {
    if (identity.githubTokens) {
      await saveGitHubTokens(deps.db, deps, owner.userId, identity.githubTokens, deps.clock.now());
    }
    await startLoginSession(deps, c, owner.userId, "login");
    return "/";
  }

  await savePending(deps, c, identity);
  return "/?signin=pending";
}

async function savePending(deps: AppDeps, c: Context, identity: ThirdPartyIdentity) {
  const now = deps.clock.now();
  // 第三方的令牌留在主站（ADR 0003）：浏览器里只放这一行的随机 ID。
  await deps.db.delete(pendingIdentities).where(lt(pendingIdentities.expiresAt, now));
  const tokens = identity.githubTokens;
  const [row] = await deps.db
    .insert(pendingIdentities)
    .values({
      provider: identity.provider,
      subject: identity.subject,
      login: identity.login,
      email: identity.email,
      githubTokens: tokens
        ? deps.secrets.seal(
            JSON.stringify({
              ...tokens,
              accessExpiresAt: tokens.accessExpiresAt.toISOString(),
              refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
            }),
          )
        : null,
      expiresAt: new Date(now.getTime() + PENDING_TTL_S * 1000),
    })
    .returning({ id: pendingIdentities.id });
  setCookie(c, PENDING_COOKIE, (row as { id: string }).id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.secureCookies,
    path: PENDING_PATH,
    maxAge: PENDING_TTL_S,
  });
}

type PendingRow = typeof pendingIdentities.$inferSelect;

/** 这个浏览器里还没过期的待处理身份。 */
async function loadPending(deps: AppDeps, c: Context): Promise<PendingRow | undefined> {
  const id = getCookie(c, PENDING_COOKIE);
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return undefined;
  const [row] = await deps.db
    .select()
    .from(pendingIdentities)
    .where(and(eq(pendingIdentities.id, id), gt(pendingIdentities.expiresAt, deps.clock.now())));
  return row;
}

function toIdentity(deps: AppDeps, row: PendingRow): ThirdPartyIdentity | undefined {
  const identity: ThirdPartyIdentity = {
    provider: row.provider,
    subject: row.subject,
    login: row.login,
    email: row.email,
  };
  if (row.githubTokens) {
    const json = deps.secrets.open(row.githubTokens);
    if (!json) return undefined;
    const tokens = JSON.parse(json) as Record<string, string>;
    identity.githubTokens = {
      accessToken: tokens.accessToken as string,
      accessExpiresAt: new Date(tokens.accessExpiresAt as string),
      refreshToken: tokens.refreshToken as string,
      refreshExpiresAt: new Date(tokens.refreshExpiresAt as string),
    };
  }
  return identity;
}

/** 给浏览器看的待处理身份：选"创建新账户"还是"登录已有账户再绑定"用。 */
export async function describePending(deps: AppDeps, c: Context) {
  const row = await loadPending(deps, c);
  if (!row) return undefined;
  const [taken] = row.email
    ? await deps.db.select({ id: users.id }).from(users).where(eq(users.email, row.email))
    : [];
  return {
    provider: row.provider,
    login: row.login,
    email: row.email,
    emailTaken: Boolean(taken),
    canRegister: Boolean(row.email) && !taken,
  };
}

/** 认领待处理身份：删掉这一行，同时提交的第二个请求就认领不到了。 */
async function claim(tx: Tx, deps: AppDeps, row: PendingRow): Promise<ThirdPartyIdentity> {
  const claimed = await tx
    .delete(pendingIdentities)
    .where(eq(pendingIdentities.id, row.id))
    .returning({ id: pendingIdentities.id });
  const identity = toIdentity(deps, row);
  if (claimed.length === 0 || !identity) throw new Abort("pending_expired");
  return identity;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: AccountError };

/** 选了"创建新账户"：用第三方的邮箱和邀请码注册，绑上身份，登录。 */
export async function registerFromPending(
  deps: AppDeps,
  c: Context,
  input: { inviteCode: string; acceptTerms?: boolean },
): Promise<Outcome<{ userId: string; email: string }>> {
  const row = await loadPending(deps, c);
  if (!row) return { ok: false, error: "pending_expired" };
  const email = row.email;
  if (!email) return { ok: false, error: "no_email" };
  const result = await inTransaction(deps, async (tx) => {
    const identity = await claim(tx, deps, row);
    // 先拿注册锁再查：同时注册的两个人都查到"没被占用"，再一起插入，就会撞上唯一约束。
    await lockRegistrations(tx);
    const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken) throw new Abort("email_taken");
    if (await findIdentity(tx, identity.provider, identity.subject)) {
      throw new Abort("identity_taken");
    }
    const userId = await registerAccount(tx, deps, { ...input, email, now: deps.clock.now() });
    await bind(tx, deps, userId, identity);
    return userId;
  });
  if (!result.ok) return result;
  deleteCookie(c, PENDING_COOKIE, { path: PENDING_PATH });
  await startLoginSession(deps, c, result.value, "register");
  return { ok: true, value: { userId: result.value, email } };
}

/** 登录已有账户以后，用户确认绑定待处理的身份。 */
export async function linkPending(
  deps: AppDeps,
  c: Context,
  userId: string,
): Promise<Outcome<{ provider: Provider; login: string }>> {
  const row = await loadPending(deps, c);
  if (!row) return { ok: false, error: "pending_expired" };
  const result = await inTransaction(deps, async (tx) => {
    const identity = await claim(tx, deps, row);
    await bind(tx, deps, userId, identity);
    return { provider: identity.provider, login: identity.login };
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) return { ok: false as const, error: "identity_taken" as const };
    throw error;
  });
  if (result.ok) deleteCookie(c, PENDING_COOKIE, { path: PENDING_PATH });
  return result;
}

/** 不想用这个第三方账号了。 */
export async function cancelPending(deps: AppDeps, c: Context): Promise<void> {
  const row = await loadPending(deps, c);
  if (row) await deps.db.delete(pendingIdentities).where(eq(pendingIdentities.id, row.id));
  deleteCookie(c, PENDING_COOKIE, { path: PENDING_PATH });
}

/** OAuth 跳转用的随机串（state）。 */
export const randomToken = () => randomBytes(24).toString("base64url");
