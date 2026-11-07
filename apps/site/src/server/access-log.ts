import { isIPv4, isIPv6 } from "node:net";
import { lt } from "drizzle-orm";
import type { Context } from "hono";
import type { AppDeps } from "./app";
import { accessLogs } from "./db/schema";
import { clientIp } from "./rate-limit";

export type AccessEvent = (typeof accessLogs.$inferInsert)["event"];

/** 访问记录保存 180 天（《网络安全法》第二十三条：网络日志不少于六个月）。 */
export const ACCESS_LOG_RETENTION_MS = 180 * 24 * 60 * 60_000;

/** 记一条访问记录：注册、登录、发起会话、发消息时调用。 */
export async function recordAccess(
  deps: Pick<AppDeps, "db" | "clock">,
  c: Context,
  userId: string,
  event: AccessEvent,
): Promise<void> {
  await deps.db
    .insert(accessLogs)
    .values({ userId, event, network: networkOf(clientIp(c)), at: deps.clock.now() });
}

/** IPv4 原样；IPv6 归到它的 /64（IPv4 映射的地址按 IPv4 算）；认不出的原样留着。 */
export function networkOf(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  if (!isIPv6(ip)) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // 末尾写成 IPv4 的部分占两组，前 64 位不受它影响，补位时按两组算就行。
  const width = (groups: string[]) => groups.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const groups = [...left, ...Array(8 - width(left) - width(right)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/** 定期任务：删掉满 180 天的访问记录。 */
export async function purgeAccessLogs(deps: Pick<AppDeps, "db" | "clock">): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - ACCESS_LOG_RETENTION_MS);
  const deleted = await deps.db
    .delete(accessLogs)
    .where(lt(accessLogs.at, cutoff))
    .returning({ id: accessLogs.id });
  return deleted.length;
}
