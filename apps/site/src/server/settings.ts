import { z } from "@hono/zod-openapi";
import { type AiLabels, DEFAULT_AI_LABELS } from "@seekcloud/protocol";
import { eq } from "drizzle-orm";
import type { AppDeps } from "./app";
import { settings } from "./db/schema";

/**
 * 全站设置。每一项有固定的键、形状和默认值；库里没有这一行，或者存的值不符合现在的形状
 * （比如旧版本写的），都按默认值算。
 */
export const AiLabelsValue = z.object({ signature: z.boolean(), commitTrailer: z.boolean() });

const AI_LABELS = "ai_labels";

type Deps = Pick<AppDeps, "db" | "clock">;

async function read<T>(deps: Pick<AppDeps, "db">, key: string, shape: z.ZodType<T>, fallback: T) {
  const [row] = await deps.db.select().from(settings).where(eq(settings.key, key));
  const parsed = shape.safeParse(row?.value);
  return parsed.success ? parsed.data : fallback;
}

async function write(deps: Deps, key: string, value: unknown): Promise<void> {
  const updatedAt = deps.clock.now();
  await deps.db
    .insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } });
}

/** AI 标识的两个开关，默认都开。 */
export const getAiLabels = (deps: Pick<AppDeps, "db">): Promise<AiLabels> =>
  read(deps, AI_LABELS, AiLabelsValue, DEFAULT_AI_LABELS);

export const setAiLabels = (deps: Deps, value: AiLabels): Promise<void> =>
  write(deps, AI_LABELS, value);
