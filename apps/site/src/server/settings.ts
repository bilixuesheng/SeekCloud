import { z } from "@hono/zod-openapi";
import {
  type AiLabels,
  DEFAULT_AI_LABELS,
  THINKING_EFFORTS,
  type ThinkingEffort,
} from "@seekcloud/protocol";
import { eq } from "drizzle-orm";
import type { AppDeps } from "./app";
import { settings } from "./db/schema";
import { DEFAULT_EFFORT } from "./sessions/models";

/**
 * 全站设置。每一项有固定的键、形状和默认值；库里没有这一行，或者存的值不符合现在的形状
 * （比如旧版本写的），都按默认值算。
 */
export const AiLabelsValue = z.object({ signature: z.boolean(), commitTrailer: z.boolean() });

export const EffortValue = z.enum(THINKING_EFFORTS);

const AI_LABELS = "ai_labels";
const DEFAULT_EFFORT_KEY = "default_effort";

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

/** 新会话默认的思考强度，默认是高档。已有的会话不跟着变。 */
export const getDefaultEffort = (deps: Pick<AppDeps, "db">): Promise<ThinkingEffort> =>
  read(deps, DEFAULT_EFFORT_KEY, EffortValue, DEFAULT_EFFORT);

export const setDefaultEffort = (deps: Deps, value: ThinkingEffort): Promise<void> =>
  write(deps, DEFAULT_EFFORT_KEY, value);
