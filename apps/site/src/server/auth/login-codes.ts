import { createHash, randomInt } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDeps } from "../app";
import { loginCodes } from "../db/schema";

const CODE_TTL_MS = 10 * 60_000;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** 给邮箱发一个 6 位验证码。同一个邮箱之前没用掉的验证码一律作废。 */
export async function sendLoginCode(deps: AppDeps, email: string): Promise<void> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const now = deps.clock.now();

  await deps.db.transaction(async (tx) => {
    await tx
      .update(loginCodes)
      .set({ consumedAt: now })
      .where(and(eq(loginCodes.email, email), isNull(loginCodes.consumedAt)));
    await tx.insert(loginCodes).values({
      email,
      codeHash: hashSecret(code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      createdAt: now,
    });
  });

  await deps.mailer.send({
    to: email,
    subject: "SeekCloud：登录验证码",
    text: `你的登录验证码：${code}，10 分钟内有效。\n\n如非本人操作，请忽略此邮件。`,
  });
}
