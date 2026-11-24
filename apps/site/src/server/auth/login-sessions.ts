import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { recordAccess } from "../access-log";
import type { AppDeps } from "../app";
import { loginSessions, users } from "../db/schema";
import { secureCookie } from "../https";
import { clientIp } from "../rate-limit";
import { describeUserAgent } from "./user-agent";

const COOKIE = "sc_login";
const LOGIN_TTL_MS = 30 * 24 * 60 * 60_000;
/** 最后使用的时间和 IP 最多隔这么久记一次：不是每个请求都写库。 */
const TOUCH_EVERY_MS = 60_000;
/** App 传上来的设备名最长这么多字。 */
export const MAX_DEVICE_NAME = 100;

/** 管理员登录用到的几样依赖。 */
export type LoginDeps = Pick<
  AppDeps,
  "db" | "clock" | "secureCookies" | "secrets" | "publicUrl" | "settingsPolicy"
>;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** 浏览器还是安卓 App（#177）。App 的登录状态是放在 Authorization 里的设备令牌，不设 Cookie。 */
export type LoginClient = { kind: "browser" } | { kind: "app"; deviceName: string | null };

/**
 * 登录（首次设置密码也算登录一次），同时记下这次的 IP。浏览器设 Cookie；App 不设 Cookie，
 * 返回设备令牌（只在这里出现一次，库里只存哈希）。
 */
export async function startLoginSession(
  deps: LoginDeps,
  c: Context,
  userId: string,
  client: LoginClient = { kind: "browser" },
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = deps.clock.now();
  await deps.db.insert(loginSessions).values({
    tokenHash: hashToken(token),
    userId,
    client: client.kind,
    // 浏览器记下是什么浏览器、什么系统，设备列表上好分辨。App 没给设备名时存空的，
    // 界面按语言显示"安卓设备"（服务端不存给人看的现成句子）
    deviceName:
      client.kind === "app"
        ? (client.deviceName?.slice(0, MAX_DEVICE_NAME) ?? null)
        : describeUserAgent(c.req.header("user-agent")),
    lastUsedAt: now,
    lastIp: await clientIp(c, deps),
    expiresAt: new Date(now.getTime() + LOGIN_TTL_MS),
    createdAt: now,
  });
  await recordAccess(deps, c, userId, "login");
  if (client.kind === "browser") {
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookie(c, deps),
      path: "/",
      maxAge: LOGIN_TTL_MS / 1000,
    });
  }
  return token;
}

/**
 * 请求带的登录凭据：有 Authorization 就只看它（App 的设备令牌），不看 Cookie；格式不对时算没登录，
 * 不退回 Cookie。所以带 Authorization 的请求不依赖 Cookie，不用过同站检查（app.ts）。
 */
function requestToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header !== undefined) {
    const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})\s*$/i.exec(header);
    return match?.[1];
  }
  return getCookie(c, COOKIE);
}

/** 这个请求的登录状态的哈希；没带登录凭据时为 undefined。 */
export function loginTokenHash(c: Context): string | undefined {
  const token = requestToken(c);
  return token ? hashToken(token) : undefined;
}

export async function currentUser(deps: LoginDeps, c: Context) {
  const tokenHash = loginTokenHash(c);
  if (!tokenHash) return undefined;
  const now = deps.clock.now();
  const [row] = await deps.db
    .select({
      id: users.id,
      sessionId: loginSessions.id,
      client: loginSessions.client,
      lastUsedAt: loginSessions.lastUsedAt,
    })
    .from(loginSessions)
    .innerJoin(users, eq(users.id, loginSessions.userId))
    .where(and(eq(loginSessions.tokenHash, tokenHash), gt(loginSessions.expiresAt, now)));
  if (!row) return undefined;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
    await deps.db
      .update(loginSessions)
      .set({
        lastUsedAt: now,
        lastIp: await clientIp(c, deps),
        // App 一直在用就一直登录着；30 天没用过才失效
        ...(row.client === "app" ? { expiresAt: new Date(now.getTime() + LOGIN_TTL_MS) } : {}),
      })
      .where(eq(loginSessions.id, row.sessionId));
  }
  return { id: row.id };
}

/** 设备列表里的一行。 */
export interface LoginDevice {
  id: string;
  client: "browser" | "app";
  deviceName: string | null;
  current: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** 这个人登录着的设备，最近用过的在前。 */
export async function listLoginSessions(
  deps: LoginDeps,
  c: Context,
  userId: string,
): Promise<LoginDevice[]> {
  const mine = loginTokenHash(c);
  const rows = await deps.db
    .select()
    .from(loginSessions)
    .where(and(eq(loginSessions.userId, userId), gt(loginSessions.expiresAt, deps.clock.now())))
    .orderBy(desc(loginSessions.lastUsedAt), desc(loginSessions.createdAt));
  return rows.map((r) => ({
    id: r.id,
    client: r.client,
    deviceName: r.deviceName,
    current: r.tokenHash === mine,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

/** 退出某一台设备。不是这个人的、已经没了的：返回 false。退出的是当前这台时连 Cookie 一起删。 */
export async function endLoginSessionById(
  deps: LoginDeps,
  c: Context,
  userId: string,
  id: string,
): Promise<boolean> {
  const removed = await deps.db
    .delete(loginSessions)
    .where(and(eq(loginSessions.id, id), eq(loginSessions.userId, userId)))
    .returning({ tokenHash: loginSessions.tokenHash });
  if (removed[0]?.tokenHash === loginTokenHash(c)) deleteCookie(c, COOKIE, { path: "/" });
  return removed.length > 0;
}

/** 在所有设备上退出：删掉这个用户的全部登录状态（包括当前这个，浏览器和 App 都算）。 */
export async function endAllLoginSessions(
  deps: LoginDeps,
  c: Context,
  userId: string,
): Promise<void> {
  await deps.db.delete(loginSessions).where(eq(loginSessions.userId, userId));
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function endLoginSession(deps: LoginDeps, c: Context): Promise<void> {
  const tokenHash = loginTokenHash(c);
  if (tokenHash) {
    await deps.db.delete(loginSessions).where(eq(loginSessions.tokenHash, tokenHash));
  }
  deleteCookie(c, COOKIE, { path: "/" });
}
