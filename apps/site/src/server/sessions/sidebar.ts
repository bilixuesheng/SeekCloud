import { MAX_GROUP_NAME, type SessionGroup } from "@seekcloud/protocol";
import { and, asc, desc, eq, isNotNull, isNull, max, ne, sql } from "drizzle-orm";
import type { AppDeps } from "../app";
import type { Tx } from "../db/client";
import { sessionGroups, sessions } from "../db/schema";

/**
 * 侧栏的分组和顺序（#153）。侧栏从上到下是置顶、各个分组、"最近"；每一类里按 sessions.sort_key 从大到小排。
 *
 * - "最近"里的会话有新动静时，sort_key 记成当时的毫秒数（sessions.ts 的 #append），回到最上面；
 *   置顶和分组里的不跟着动。
 * - 拖动放下时（place），取前后两个会话的中间值；前后挨得太近、分不开了，就把这一类重新编一遍号。
 * - 置顶和分组互斥：置顶的不在分组里，放进分组就取消置顶。
 */

/** 放到哪一类。 */
export type SidebarSection =
  | { kind: "pinned" }
  | { kind: "group"; groupId: string }
  | { kind: "recent" };

/** 一个人最多建这么多分组。 */
export const MAX_GROUPS = 100;
/** 放在最上面、最下面时，和挨着的那个隔多少。 */
const GAP = 1000;

export type SidebarError =
  | "session_not_found"
  | "session_archived"
  | "group_not_found"
  | "too_many_groups";

type Result<T> = { ok: true; value: T } | { ok: false; error: SidebarError };

type Deps = Pick<AppDeps, "db" | "clock">;

/** 分组名：去掉首尾空格，不能为空，最长 MAX_GROUP_NAME 个字。不合规矩时是 undefined。 */
export function groupName(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed && [...trimmed].length <= MAX_GROUP_NAME ? trimmed : undefined;
}

/** 前后两个之间放一个：中间值；只有一边时隔 GAP（"最近"的最上面不小于现在，免得被新动静的盖住又跳回来）。 */
export function keyBetween(
  above: number | undefined,
  below: number | undefined,
  options: { now: number; recentTop: boolean },
): number {
  if (above !== undefined && below !== undefined) return (above + below) / 2;
  if (above !== undefined) return above - GAP;
  if (below !== undefined) {
    return options.recentTop ? Math.max(options.now, below + 1) : below + GAP;
  }
  return options.now;
}

export class Sidebar {
  readonly #deps: Deps;
  readonly #changed: (userId: string, shortIds: string[]) => void;
  readonly #groupsChanged: (userId: string) => void;

  constructor(
    deps: Deps,
    notify: {
      sessions: (userId: string, shortIds: string[]) => void;
      groups: (userId: string) => void;
    },
  ) {
    this.#deps = deps;
    this.#changed = notify.sessions;
    this.#groupsChanged = notify.groups;
  }

  async groups(userId: string): Promise<SessionGroup[]> {
    const rows = await this.#deps.db
      .select()
      .from(sessionGroups)
      .where(eq(sessionGroups.userId, userId))
      .orderBy(asc(sessionGroups.sortKey), asc(sessionGroups.createdAt));
    return rows.map(toGroup);
  }

  /** 新建一个分组，放在最后。name 已经过 groupName。 */
  async createGroup(userId: string, name: string): Promise<Result<SessionGroup>> {
    const created = await this.#deps.db.transaction(async (tx) => {
      // 同一个人的分组排队建：数个数、取最大的顺序不会撞
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`session_groups:${userId}`}))`);
      const [stats] = await tx
        .select({ count: sql<number>`count(*)::int`, last: max(sessionGroups.sortKey) })
        .from(sessionGroups)
        .where(eq(sessionGroups.userId, userId));
      if ((stats?.count ?? 0) >= MAX_GROUPS) return undefined;
      const [row] = await tx
        .insert(sessionGroups)
        .values({
          userId,
          name,
          sortKey: (stats?.last ?? 0) + 1,
          createdAt: this.#deps.clock.now(),
        })
        .returning();
      return row;
    });
    if (!created) return { ok: false, error: "too_many_groups" };
    this.#groupsChanged(userId);
    return { ok: true, value: toGroup(created) };
  }

  async renameGroup(userId: string, id: string, name: string): Promise<Result<SessionGroup>> {
    const [row] = await this.#deps.db
      .update(sessionGroups)
      .set({ name })
      .where(and(eq(sessionGroups.id, id), eq(sessionGroups.userId, userId)))
      .returning();
    if (!row) return { ok: false, error: "group_not_found" };
    this.#groupsChanged(userId);
    return { ok: true, value: toGroup(row) };
  }

  /** 删掉分组：里面的会话回到"最近"，按各自最近有动静的时间排。正在运行的照常运行。 */
  async deleteGroup(userId: string, id: string): Promise<Result<void>> {
    const moved = await this.#deps.db.transaction(async (tx) => {
      const [group] = await tx
        .select({ id: sessionGroups.id })
        .from(sessionGroups)
        .where(and(eq(sessionGroups.id, id), eq(sessionGroups.userId, userId)))
        .for("update");
      if (!group) return undefined;
      const rows = await tx
        .update(sessions)
        .set({ groupId: null, sortKey: naturalKey })
        .where(and(eq(sessions.groupId, id), eq(sessions.userId, userId)))
        .returning({ shortId: sessions.shortId });
      await tx.delete(sessionGroups).where(eq(sessionGroups.id, id));
      return rows.map((r) => r.shortId);
    });
    if (!moved) return { ok: false, error: "group_not_found" };
    this.#groupsChanged(userId);
    if (moved.length > 0) this.#changed(userId, moved);
    return { ok: true, value: undefined };
  }

  /**
   * 把会话放到某一类里、某个会话的下面（after 是挨着它上面的那个会话的短 ID；null 是最上面）。
   * after 不在那一类里了（这期间列表变了）就放在最上面。已归档的会话不能放。
   */
  async place(
    userId: string,
    shortId: string,
    section: SidebarSection,
    after: string | null,
  ): Promise<Result<void>> {
    const done = await this.#deps.db.transaction(async (tx): Promise<Result<void>> => {
      const [session] = await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.shortId, shortId)))
        .for("update");
      if (!session) return { ok: false, error: "session_not_found" };
      if (session.status === "archived") return { ok: false, error: "session_archived" };
      if (section.kind === "group") {
        const [group] = await tx
          .select({ id: sessionGroups.id })
          .from(sessionGroups)
          .where(and(eq(sessionGroups.id, section.groupId), eq(sessionGroups.userId, userId)));
        if (!group) return { ok: false, error: "group_not_found" };
      }
      const now = this.#deps.clock.now();
      const sortKey = await this.#keyFor(tx, userId, section, session.id, after, now.getTime());
      await tx
        .update(sessions)
        .set({
          pinnedAt: section.kind === "pinned" ? (session.pinnedAt ?? now) : null,
          groupId: section.kind === "group" ? section.groupId : null,
          sortKey,
        })
        .where(eq(sessions.id, session.id));
      return { ok: true, value: undefined };
    });
    if (done.ok) this.#changed(userId, [shortId]);
    return done;
  }

  /** 菜单里点"置顶"：放在置顶的最上面。 */
  pinKey(tx: Tx, userId: string, sessionId: string, now: Date): Promise<number> {
    return this.#keyFor(tx, userId, { kind: "pinned" }, sessionId, null, now.getTime());
  }

  async #keyFor(
    tx: Tx,
    userId: string,
    section: SidebarSection,
    sessionId: string,
    after: string | null,
    now: number,
  ): Promise<number> {
    const others = await this.#sectionRows(tx, userId, section, sessionId);
    const i = after === null ? -1 : others.findIndex((r) => r.shortId === after);
    const above = i >= 0 ? others[i] : undefined;
    const below = others[i + 1];
    const options = { now, recentTop: section.kind === "recent" };
    const key = keyBetween(above?.sortKey, below?.sortKey, options);
    // 挨得太近、中间值和某一边一样了：这一类重新编号（从上到下隔 GAP），再取一次
    if (key === above?.sortKey || key === below?.sortKey) {
      const top = others[0]?.sortKey ?? now;
      for (const [n, row] of others.entries()) {
        row.sortKey = top - n * GAP;
        await tx.update(sessions).set({ sortKey: row.sortKey }).where(eq(sessions.id, row.id));
      }
      if (others.length > 0)
        this.#changed(
          userId,
          others.map((r) => r.shortId),
        );
      return keyBetween(above?.sortKey, below?.sortKey, options);
    }
    return key;
  }

  /** 某一类里除了 sessionId 以外的会话，按顺序（从上到下）。 */
  async #sectionRows(tx: Tx, userId: string, section: SidebarSection, sessionId: string) {
    const where = [
      eq(sessions.userId, userId),
      ne(sessions.id, sessionId),
      ne(sessions.status, "archived"),
      section.kind === "pinned"
        ? isNotNull(sessions.pinnedAt)
        : section.kind === "group"
          ? and(isNull(sessions.pinnedAt), eq(sessions.groupId, section.groupId))
          : and(isNull(sessions.pinnedAt), isNull(sessions.groupId)),
    ];
    return tx
      .select({ id: sessions.id, shortId: sessions.shortId, sortKey: sessions.sortKey })
      .from(sessions)
      .where(and(...where))
      .orderBy(desc(sessions.sortKey), desc(sessions.createdAt));
  }
}

/** 回到"最近"时的位置：按最近有动静的时间排，和没被拖过一样。 */
export const naturalKey = sql<number>`floor(extract(epoch from ${sessions.updatedAt}) * 1000)`;

const toGroup = (row: typeof sessionGroups.$inferSelect): SessionGroup => ({
  id: row.id,
  name: row.name,
  sortKey: row.sortKey,
});
