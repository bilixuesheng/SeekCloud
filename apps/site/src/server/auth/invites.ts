import { randomInt } from "node:crypto";
import type { AppDeps } from "../app";
import { inviteCodes } from "../db/schema";

// 去掉了容易看混的 0、O、1、I。
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 存的时候不带分隔符；给人看的时候写成 ABCD-EFGH。 */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function createInviteCode(
  deps: Pick<AppDeps, "db" | "clock">,
  invite: { expiresAt?: Date } = {},
): Promise<string> {
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  await deps.db.insert(inviteCodes).values({
    code,
    expiresAt: invite.expiresAt ?? null,
    createdAt: deps.clock.now(),
  });
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
