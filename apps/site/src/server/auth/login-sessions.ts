import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type AccessEvent, recordAccess } from "../access-log";
import type { AppDeps } from "../app";
import { loginSessions, users } from "../db/schema";
import { hashSecret } from "./login-codes";

const COOKIE = "sc_login";
const LOGIN_TTL_MS = 30 * 24 * 60 * 60_000;

/** 登录（注册完也算登录一次），同时记下这次的 IP。 */
export async function startLoginSession(
  deps: AppDeps,
  c: Context,
  userId: string,
  event: Extract<AccessEvent, "register" | "login">,
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const now = deps.clock.now();
  await deps.db.insert(loginSessions).values({
    tokenHash: hashSecret(token),
    userId,
    expiresAt: new Date(now.getTime() + LOGIN_TTL_MS),
    createdAt: now,
  });
  await recordAccess(deps, c, userId, event);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.secureCookies,
    path: "/",
    maxAge: LOGIN_TTL_MS / 1000,
  });
}

export async function currentUser(deps: AppDeps, c: Context) {
  const token = getCookie(c, COOKIE);
  if (!token) return undefined;
  const [row] = await deps.db
    .select({ id: users.id, email: users.email })
    .from(loginSessions)
    .innerJoin(users, eq(users.id, loginSessions.userId))
    .where(
      and(
        eq(loginSessions.tokenHash, hashSecret(token)),
        gt(loginSessions.expiresAt, deps.clock.now()),
      ),
    );
  return row;
}

/** 在所有设备上退出：删掉这个用户的全部登录状态（包括当前这个）。 */
export async function endAllLoginSessions(
  deps: AppDeps,
  c: Context,
  userId: string,
): Promise<void> {
  await deps.db.delete(loginSessions).where(eq(loginSessions.userId, userId));
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function endLoginSession(deps: AppDeps, c: Context): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) {
    await deps.db.delete(loginSessions).where(eq(loginSessions.tokenHash, hashSecret(token)));
  }
  deleteCookie(c, COOKIE, { path: "/" });
}
