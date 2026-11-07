import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app";
import { githubTokens, identities } from "../db/schema";
import { GitHubAuthError, type GitHubTokens } from "./port";

const REFRESH_AHEAD_MS = 5 * 60_000;

type Db = Pick<AppDeps["db"], "insert">;

export async function saveGitHubTokens(
  db: Db,
  deps: Pick<AppDeps, "secrets">,
  userId: string,
  tokens: GitHubTokens,
  now: Date,
): Promise<void> {
  const row = {
    accessToken: deps.secrets.seal(tokens.accessToken),
    accessExpiresAt: tokens.accessExpiresAt,
    refreshToken: deps.secrets.seal(tokens.refreshToken),
    refreshExpiresAt: tokens.refreshExpiresAt,
    updatedAt: now,
  };
  await db
    .insert(githubTokens)
    .values({ userId, ...row })
    .onConflictDoUpdate({ target: githubTokens.userId, set: row });
}

/**
 * 拿一个能用的 GitHub 访问令牌：快过期就先刷新。
 * GitHub 的刷新令牌只能用一次，所以刷新时锁住这一行；拿到锁后再看一眼，别的请求可能已经刷新过了。
 * 只有 GitHub 明确说令牌失效时才删掉令牌（算作没关联）；网络出错就把错误抛出去，令牌留着。
 */
export async function githubAccessToken(deps: AppDeps, userId: string) {
  const now = deps.clock.now();
  const fresh = (row: { accessExpiresAt: Date }) =>
    row.accessExpiresAt.getTime() - now.getTime() > REFRESH_AHEAD_MS;

  const [row] = await deps.db.select().from(githubTokens).where(eq(githubTokens.userId, userId));
  if (!row) return undefined;
  if (fresh(row)) return deps.secrets.open(row.accessToken);

  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(githubTokens)
      .where(eq(githubTokens.userId, userId))
      .for("update");
    if (!locked) return undefined;
    if (fresh(locked)) return deps.secrets.open(locked.accessToken);

    const refreshToken = deps.secrets.open(locked.refreshToken);
    try {
      if (!refreshToken || locked.refreshExpiresAt <= now) {
        throw new GitHubAuthError("刷新令牌已过期");
      }
      const tokens = await deps.github.refreshTokens(refreshToken);
      await saveGitHubTokens(tx, deps, userId, tokens, now);
      return tokens.accessToken;
    } catch (error) {
      if (!(error instanceof GitHubAuthError)) throw error;
      await tx.delete(githubTokens).where(eq(githubTokens.userId, userId));
      return undefined;
    }
  });
}

/**
 * 用这个用户的 GitHub 令牌调 GitHub。没关联返回 "not_connected"；
 * GitHub 说令牌失效（比如用户撤销了授权）时，删掉令牌，也返回 "not_connected"。
 */
export async function withGitHubToken<T>(
  deps: AppDeps,
  userId: string,
  call: (token: string) => Promise<T>,
): Promise<T | "not_connected"> {
  const token = await githubAccessToken(deps, userId);
  if (!token) return "not_connected";
  try {
    return await call(token);
  } catch (error) {
    if (!(error instanceof GitHubAuthError)) throw error;
    await disconnectGitHub(deps, userId);
    return "not_connected";
  }
}

/** GitHub 不认这个用户的令牌了：删掉，算作没关联。 */
export async function disconnectGitHub(deps: AppDeps, userId: string): Promise<void> {
  await deps.db.delete(githubTokens).where(eq(githubTokens.userId, userId));
}

/** 用户关联的 GitHub 账号；令牌失效时返回 undefined。 */
export async function githubConnection(deps: AppDeps, userId: string) {
  const [row] = await deps.db
    .select({ login: identities.login, refreshExpiresAt: githubTokens.refreshExpiresAt })
    .from(identities)
    .innerJoin(githubTokens, eq(githubTokens.userId, identities.userId))
    .where(and(eq(identities.userId, userId), eq(identities.provider, "github")));
  if (!row || row.refreshExpiresAt <= deps.clock.now()) return undefined;
  return { login: row.login };
}
