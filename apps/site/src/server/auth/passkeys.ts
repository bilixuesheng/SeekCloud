import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, asc, eq } from "drizzle-orm";
import type { AppDeps } from "../app";
import { passkeys } from "../db/schema";
import type { Clock } from "../ports";

/**
 * 通行密钥（WebAuthn，#100）：设置里添加，登录页"使用通行密钥登录"，通过了不用再输密码和验证码。
 * 校验交给 SimpleWebAuthn（MIT）。要求用户验证（指纹、面容、设备密码）；挑战值一次性、5 分钟；
 * rpId 和来源按主站对外的地址（PUBLIC_URL）定，地址改了旧的通行密钥就用不了。
 */

export type PasskeyDeps = Pick<AppDeps, "db" | "clock" | "publicUrl">;

export interface RelyingParty {
  rpId: string;
  origin: string;
}

/** 通行密钥能不能用：配了 PUBLIC_URL，而且是 HTTPS（本机的 localhost 可以是 HTTP）。浏览器也只在这些地方给用。 */
export function relyingParty(publicUrl: string | undefined): RelyingParty | undefined {
  if (!publicUrl) return undefined;
  try {
    const url = new URL(publicUrl);
    const local = url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
    return { rpId: url.hostname, origin: url.origin };
  } catch {
    return undefined;
  }
}

const CHALLENGE_TTL_MS = 5 * 60_000;
/** 登录的挑战值谁都能要：最多留这么多个，多了先扔最早的。 */
const MAX_CHALLENGES = 1000;

type Purpose = "register" | "login";

/** 挑战值：一次性、5 分钟有效。放在内存里就够了（主站只有一个进程，重启以后重新点一次就行）。 */
export class Challenges {
  readonly #items = new Map<string, { purpose: Purpose; userId?: string; expiresAt: number }>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  add(challenge: string, purpose: Purpose, userId?: string): void {
    const now = this.#clock.now().getTime();
    for (const [key, item] of this.#items) if (item.expiresAt <= now) this.#items.delete(key);
    while (this.#items.size >= MAX_CHALLENGES) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
    }
    this.#items.set(challenge, { purpose, userId, expiresAt: now + CHALLENGE_TTL_MS });
  }

  /** 用掉一个挑战值：不管对不对，用过就删。 */
  take(challenge: string, purpose: Purpose, userId?: string): boolean {
    const item = this.#items.get(challenge);
    this.#items.delete(challenge);
    return (
      item !== undefined &&
      item.purpose === purpose &&
      item.expiresAt > this.#clock.now().getTime() &&
      (userId === undefined || item.userId === userId)
    );
  }
}

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** 主站换了地址以后，旧地址上添加的通行密钥用不了。 */
  usable: boolean;
}

export async function listPasskeys(
  deps: PasskeyDeps,
  userId: string,
): Promise<{ rp: RelyingParty | undefined; passkeys: PasskeyView[] }> {
  const rp = relyingParty(deps.publicUrl);
  const rows = await deps.db
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(asc(passkeys.createdAt));
  return {
    rp,
    passkeys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      usable: rp?.rpId === row.rpId,
    })),
  };
}

/** 添加的第一步：给浏览器的参数。已经有的不让再加一遍（excludeCredentials）。 */
export async function registrationOptions(
  deps: PasskeyDeps,
  challenges: Challenges,
  rp: RelyingParty,
  userId: string,
) {
  const existing = await deps.db
    .select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
  const options = await generateRegistrationOptions({
    rpName: "SeekCloud",
    rpID: rp.rpId,
    userName: "admin",
    userDisplayName: "SeekCloud 管理员",
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((e) => ({
      id: e.credentialId,
      transports: e.transports ?? undefined,
    })),
    // 存在认证器里的（可发现的）通行密钥：登录时不用先输用户名
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  challenges.add(options.challenge, "register", userId);
  return options;
}

/** 添加的第二步：核对浏览器交回来的结果，存下公钥。核对不过返回 undefined。 */
export async function finishRegistration(
  deps: PasskeyDeps,
  challenges: Challenges,
  rp: RelyingParty,
  userId: string,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeyView | undefined> {
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: (challenge) => challenges.take(challenge, "register", userId),
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
    });
  } catch {
    return undefined;
  }
  if (!verified.verified) return undefined;
  const { credential } = verified.registrationInfo;
  const [row] = await deps.db
    .insert(passkeys)
    .values({
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports ?? null,
      name,
      rpId: rp.rpId,
      createdAt: deps.clock.now(),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: null,
    usable: true,
  };
}

/** 登录的第一步：给浏览器的参数。不列出有哪些通行密钥（可发现的通行密钥由认证器自己挑）。 */
export async function authenticationOptions(challenges: Challenges, rp: RelyingParty) {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    userVerification: "required",
  });
  challenges.add(options.challenge, "login");
  return options;
}

/** 登录的第二步：核对签名，记下计数和最后使用的时间。成功时返回是谁。 */
export async function finishAuthentication(
  deps: PasskeyDeps,
  challenges: Challenges,
  rp: RelyingParty,
  response: AuthenticationResponseJSON,
): Promise<string | undefined> {
  const [row] = await deps.db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.credentialId, response.id), eq(passkeys.rpId, rp.rpId)));
  if (!row) return undefined;
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (challenge) => challenges.take(challenge, "login"),
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      credential: {
        id: row.credentialId,
        publicKey: Buffer.from(row.publicKey, "base64url"),
        counter: row.counter,
        transports: row.transports ?? undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    return undefined;
  }
  if (!verified.verified) return undefined;
  await deps.db
    .update(passkeys)
    .set({ counter: verified.authenticationInfo.newCounter, lastUsedAt: deps.clock.now() })
    .where(eq(passkeys.id, row.id));
  return row.userId;
}

/** 删掉一个。不是这个人的、没有这个的返回 false。 */
export async function deletePasskey(
  deps: Pick<AppDeps, "db">,
  userId: string,
  id: string,
): Promise<boolean> {
  const deleted = await deps.db
    .delete(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
    .returning({ id: passkeys.id });
  return deleted.length > 0;
}

/** 重置命令：全部删掉，返回删了几个。 */
export async function deleteAllPasskeys(
  deps: Pick<AppDeps, "db">,
  userId: string,
): Promise<number> {
  const deleted = await deps.db
    .delete(passkeys)
    .where(eq(passkeys.userId, userId))
    .returning({ id: passkeys.id });
  return deleted.length;
}
