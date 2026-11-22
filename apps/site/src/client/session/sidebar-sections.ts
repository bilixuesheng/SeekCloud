import type { SessionGroup } from "@seekcloud/protocol";
import { useCallback, useState } from "react";
import type { Session } from "./types";

/** 侧栏从上到下（#153）：置顶、各个分组、"最近"，已归档的收在最下面。每一类里按 sortKey 从大到小。 */
export interface SidebarSections {
  pinned: Session[];
  groups: Array<{ group: SessionGroup; sessions: Session[] }>;
  recent: Session[];
  archived: Session[];
}

const bySortKey = (a: Session, b: Session) =>
  b.sortKey - a.sortKey || b.createdAt.localeCompare(a.createdAt);

/**
 * 把会话分到侧栏的几类里。搜索时不分类，匹配的都放在"最近"里，按最近有动静的排。
 * 分组没了（别的设备上删了、还没收到推送）的会话先放在"最近"里。
 */
export function sidebarSections(
  sessions: Session[],
  groups: SessionGroup[],
  query = "",
): SidebarSections {
  const q = query.trim().toLowerCase();
  if (q) {
    const recent = sessions
      .filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.repos.some((r) => r.fullName.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { pinned: [], groups: [], recent, archived: [] };
  }
  const live = sessions.filter((s) => s.status !== "archived");
  const known = new Set(groups.map((g) => g.id));
  return {
    pinned: live.filter((s) => s.pinnedAt !== null).sort(bySortKey),
    groups: [...groups]
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((group) => ({
        group,
        sessions: live.filter((s) => s.pinnedAt === null && s.groupId === group.id).sort(bySortKey),
      })),
    recent: live
      .filter((s) => s.pinnedAt === null && (s.groupId === null || !known.has(s.groupId)))
      .sort(bySortKey),
    archived: sessions.filter((s) => s.status === "archived"),
  };
}

const COLLAPSED_KEY = "seekcloud.sidebar.collapsed";

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** 哪几类折叠着（"pinned"、"group:<id>"），记在这台设备上；存不了（隐私模式）时只在这次打开里记着。 */
export function useCollapsed(): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // 存不了就算了
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}
