import type { SessionGroup } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";
import { sidebarSections } from "./sidebar-sections";
import type { Session } from "./types";

const session = (shortId: string, over: Partial<Session> = {}): Session =>
  ({
    shortId,
    title: shortId,
    status: "waiting",
    detail: null,
    repos: [{ fullName: "octo/app" }],
    pinnedAt: null,
    groupId: null,
    sortKey: 0,
    unread: false,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  }) as unknown as Session;

const groups: SessionGroup[] = [
  { id: "g2", name: "后端", sortKey: 2 },
  { id: "g1", name: "前端", sortKey: 1 },
];

describe("侧栏的几类", () => {
  it("置顶、分组（按分组的顺序）、最近、已归档；每一类里 sortKey 大的在前", () => {
    const list = [
      session("a", { sortKey: 1 }),
      session("b", { sortKey: 3 }),
      session("p1", { pinnedAt: "2026-11-02T00:00:00Z", sortKey: 5 }),
      session("p2", { pinnedAt: "2026-11-03T00:00:00Z", sortKey: 9 }),
      session("f1", { groupId: "g1", sortKey: 1 }),
      session("f2", { groupId: "g1", sortKey: 2 }),
      session("bk", { groupId: "g2", sortKey: 7 }),
      session("old", { status: "archived", sortKey: 100 }),
    ];
    const s = sidebarSections(list, groups);
    expect(s.pinned.map((x) => x.shortId)).toEqual(["p2", "p1"]);
    expect(s.groups.map((g) => [g.group.name, g.sessions.map((x) => x.shortId)])).toEqual([
      ["前端", ["f2", "f1"]],
      ["后端", ["bk"]],
    ]);
    expect(s.recent.map((x) => x.shortId)).toEqual(["b", "a"]);
    expect(s.archived.map((x) => x.shortId)).toEqual(["old"]);
  });

  it("空的分组照样显示；分组已经没了的会话先放在“最近”里", () => {
    const s = sidebarSections([session("lost", { groupId: "gone" })], groups);
    expect(s.groups.map((g) => g.sessions.length)).toEqual([0, 0]);
    expect(s.recent.map((x) => x.shortId)).toEqual(["lost"]);
  });

  it("搜索时不分类：标题或仓库匹配的都在“最近”里，按最近有动静的排，已归档的也搜", () => {
    const list = [
      session("修登录", { pinnedAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }),
      session("登录页", { groupId: "g1", updatedAt: "2026-11-05T00:00:00Z" }),
      session("旧的登录", { status: "archived", updatedAt: "2026-11-03T00:00:00Z" }),
      session("别的"),
    ];
    const s = sidebarSections(list, groups, " 登录 ");
    expect(s.recent.map((x) => x.shortId)).toEqual(["登录页", "旧的登录", "修登录"]);
    expect(s.pinned).toEqual([]);
    expect(s.groups).toEqual([]);
  });
});
