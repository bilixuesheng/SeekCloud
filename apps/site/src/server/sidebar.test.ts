import type { Session, SessionGroup } from "@seekcloud/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";
import { sessions as sessionsTable } from "./db/schema";
import { keyBetween } from "./sessions/sidebar";

/** 侧栏的分组和顺序（#153）：建、改名、删分组，放置会话，有新动静时的顺序。 */
describe("侧栏的分组和顺序", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  const start = async (text: string) => {
    t.clock.advance(1000);
    const res = await browser.post("/api/sessions", { repo: "octo/app", baseBranch: "main", text });
    expect(res.status).toBe(201);
    await t.host.idle();
    return ((await res.json()) as { shortId: string }).shortId;
  };
  const all = async () =>
    ((await (await browser.get("/api/sessions")).json()) as { sessions: Session[] }).sessions;
  /** 侧栏里的样子：每一类的短 ID，从上到下。 */
  const sidebar = async () => {
    const list = (await all()).filter((s) => s.status !== "archived");
    const order = (xs: Session[]) =>
      [...xs].sort((a, b) => b.sortKey - a.sortKey).map((s) => s.shortId);
    return {
      pinned: order(list.filter((s) => s.pinnedAt !== null)),
      groups: (group: string) => order(list.filter((s) => s.groupId === group && !s.pinnedAt)),
      recent: order(list.filter((s) => s.pinnedAt === null && s.groupId === null)),
    };
  };
  const place = (shortId: string, body: Record<string, unknown>) =>
    browser.post(`/api/sessions/${shortId}/place`, body);
  const createGroup = async (name: string) => {
    const res = await browser.post("/api/session-groups", { name });
    expect(res.status).toBe(201);
    return (await res.json()) as SessionGroup;
  };
  const json = (method: string, body: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("分组：建（去掉首尾空格，排在最后）、改名、名字为空或太长不收", async () => {
    const first = await createGroup("  前端  ");
    expect(first.name).toBe("前端");
    const second = await createGroup("后端");
    expect(second.sortKey).toBeGreaterThan(first.sortKey);
    expect((await browser.post("/api/session-groups", { name: "   " })).status).toBe(400);
    expect((await browser.post("/api/session-groups", { name: "长".repeat(41) })).status).toBe(400);
    expect((await browser.post("/api/session-groups", { name: "长".repeat(40) })).status).toBe(201);
    const renamed = await browser.request(
      `/api/session-groups/${first.id}`,
      json("PATCH", { name: "界面" }),
    );
    expect(renamed.status).toBe(200);
    const { groups } = (await (await browser.get("/api/session-groups")).json()) as {
      groups: SessionGroup[];
    };
    expect(groups.map((g) => g.name).slice(0, 2)).toEqual(["界面", "后端"]);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(
      (await browser.request(`/api/session-groups/${missing}`, json("PATCH", { name: "x" })))
        .status,
    ).toBe(404);
    expect((await browser.request("/api/session-groups/abc", json("DELETE", {}))).status).toBe(400);
  });

  it("放置：拖进置顶、放进分组、在“最近”里调顺序，都按 after 放；after 不在那一类里时放最上面", async () => {
    const a = await start("甲");
    const b = await start("乙");
    const c = await start("丙");
    const d = await start("丁");
    expect((await sidebar()).recent.slice(0, 4)).toEqual([d, c, b, a]);

    // "最近"里把甲拖到丁下面
    expect((await place(a, { section: "recent", after: d })).status).toBe(200);
    expect((await sidebar()).recent.slice(0, 4)).toEqual([d, a, c, b]);

    // 拖进置顶：先丙，再把乙放在丙下面，再把丁放最上面
    await place(c, { section: "pinned", after: null });
    await place(b, { section: "pinned", after: c });
    await place(d, { section: "pinned", after: null });
    expect((await sidebar()).pinned).toEqual([d, c, b]);

    // 放进分组：置顶的丙放进分组就取消置顶
    const group = await createGroup("一组");
    const res = await place(c, { section: "group", groupId: group.id, after: null });
    expect(((await res.json()) as Session).pinnedAt).toBeNull();
    await place(b, { section: "group", groupId: group.id, after: c });
    await place(a, { section: "group", groupId: group.id, after: "不存在的会话" });
    const now = await sidebar();
    expect(now.groups(group.id)).toEqual([a, c, b]);
    expect(now.pinned).toEqual([d]);

    // 从分组拖回"最近"
    await place(a, { section: "recent", after: null });
    expect((await sidebar()).recent[0]).toBe(a);
    expect((await sidebar()).groups(group.id)).toEqual([c, b]);

    // 放进分组要给分组；分组不存在、会话不存在
    expect((await place(a, { section: "group", after: null })).status).toBe(400);
    expect(
      (
        await place(a, {
          section: "group",
          groupId: "00000000-0000-4000-8000-000000000000",
          after: null,
        })
      ).status,
    ).toBe(404);
    expect((await place("nope", { section: "recent", after: null })).status).toBe(404);
  });

  it("有新动静：“最近”里的回到最上面；置顶和分组里的顺序不动", async () => {
    const pinnedOld = await start("置顶的旧会话");
    const pinnedNew = await start("置顶的新会话");
    await place(pinnedOld, { section: "pinned", after: null });
    await place(pinnedNew, { section: "pinned", after: pinnedOld });
    const group = await createGroup("动静");
    const inGroupA = await start("组里甲");
    const inGroupB = await start("组里乙");
    await place(inGroupA, { section: "group", groupId: group.id, after: null });
    await place(inGroupB, { section: "group", groupId: group.id, after: inGroupA });
    const recentOld = await start("最近的旧会话");
    await start("最近的新会话");

    const before = await sidebar();
    // 每个会话都发一条消息（新回合跑完）
    for (const id of [pinnedNew, inGroupB, recentOld]) {
      t.clock.advance(1000);
      expect((await browser.post(`/api/sessions/${id}/messages`, { text: "再来" })).status).toBe(
        201,
      );
      await t.host.idle();
    }
    const after = await sidebar();
    expect(after.recent[0]).toBe(recentOld);
    expect(after.pinned.slice(0, 2)).toEqual(before.pinned.slice(0, 2));
    expect(after.groups(group.id)).toEqual([inGroupA, inGroupB]);
  });

  it("菜单里置顶：放在置顶的最上面，离开分组；取消置顶回到“最近”；归档时离开分组和置顶", async () => {
    const group = await createGroup("菜单");
    const x = await start("菜单甲");
    await place(x, { section: "group", groupId: group.id, after: null });
    const pinned = (await (
      await browser.post(`/api/sessions/${x}/pin`, { pinned: true })
    ).json()) as Session;
    expect(pinned.groupId).toBeNull();
    expect((await sidebar()).pinned[0]).toBe(x);
    await browser.post(`/api/sessions/${x}/pin`, { pinned: false });
    expect((await sidebar()).recent).toContain(x);

    const y = await start("菜单乙");
    await place(y, { section: "group", groupId: group.id, after: null });
    await browser.post(`/api/sessions/${y}/archive`);
    const archived = (await all()).find((s) => s.shortId === y) as Session;
    expect(archived).toMatchObject({ groupId: null, pinnedAt: null, status: "archived" });
    expect((await place(y, { section: "pinned", after: null })).status).toBe(409);
  });

  it("删除分组：里面的会话回到“最近”，按各自最近有动静的时间排；分组没了", async () => {
    const group = await createGroup("要删的");
    const older = await start("组里旧的");
    const newer = await start("组里新的");
    await place(newer, { section: "group", groupId: group.id, after: null });
    await place(older, { section: "group", groupId: group.id, after: null });
    t.clock.advance(1000);
    const res = await browser.request(`/api/session-groups/${group.id}`, json("DELETE", {}));
    expect(res.status).toBe(204);
    const recent = (await sidebar()).recent;
    expect(recent.indexOf(newer)).toBeLessThan(recent.indexOf(older));
    expect(recent.indexOf(newer)).toBe(0);
    const { groups } = (await (await browser.get("/api/session-groups")).json()) as {
      groups: SessionGroup[];
    };
    expect(groups.map((g) => g.id)).not.toContain(group.id);
    expect(
      (await browser.request(`/api/session-groups/${group.id}`, json("DELETE", {}))).status,
    ).toBe(404);
  });

  it("前后两个挨得太近、分不开：这一类重新编号，顺序照样对", async () => {
    const group = await createGroup("挤");
    const [p, q, r] = [await start("挤甲"), await start("挤乙"), await start("挤丙")];
    await place(p, { section: "group", groupId: group.id, after: null });
    await place(q, { section: "group", groupId: group.id, after: p });
    // 让甲、乙的顺序值只差一点点
    const [pRow] = await t.db
      .select({ sortKey: sessionsTable.sortKey })
      .from(sessionsTable)
      .where(eq(sessionsTable.shortId, p));
    // 比甲小一点点：两个挨着的双精度数，中间值会舍入成其中一个
    const pKey = pRow?.sortKey ?? 0;
    const bits = new Float64Array([pKey]);
    const raw = new BigInt64Array(bits.buffer);
    raw[0] = (raw[0] as bigint) - 1n;
    const tight = bits[0] as number;
    expect(tight).toBeLessThan(pKey);
    expect([pKey, tight]).toContain((pKey + tight) / 2);
    await t.db.update(sessionsTable).set({ sortKey: tight }).where(eq(sessionsTable.shortId, q));
    await place(r, { section: "group", groupId: group.id, after: p });
    expect((await sidebar()).groups(group.id)).toEqual([p, r, q]);
  });

  it("列表的事件流：快照里有分组；建、改名、删分组时推一条 groups；放置时推会话", async () => {
    const stream = await browser.stream("/api/sessions/stream");
    const snapshot = await stream.next();
    expect(snapshot.event).toBe("snapshot");
    expect(JSON.parse(snapshot.data)).toHaveProperty("groups");
    const group = await createGroup("推送");
    const created = await stream.until((e) => e.event === "groups");
    const groups = JSON.parse(created.at(-1)?.data ?? "{}").groups as SessionGroup[];
    expect(groups.map((g) => g.name)).toContain("推送");

    const s = (await all())[0] as Session;
    await place(s.shortId, { section: "group", groupId: group.id, after: null });
    const moved = await stream.until(
      (e) => e.event === "session" && JSON.parse(e.data).groupId === group.id,
    );
    expect(moved.length).toBeGreaterThan(0);
    await stream.close();
  });
});

describe("前后两个之间放一个", () => {
  it.each<[number | undefined, number | undefined, string]>([
    [10, 2, "between"],
    [10, undefined, "bottom"],
    [undefined, 2, "top"],
  ])("上 %s、下 %s：%s", (above, below) => {
    const key = keyBetween(above, below, { now: 0, recentTop: false });
    if (above !== undefined) expect(key).toBeLessThan(above);
    if (below !== undefined) expect(key).toBeGreaterThan(below);
  });

  it("“最近”的最上面不小于现在（新动静盖不过它又跳回来）；空的一类用现在", () => {
    expect(keyBetween(undefined, 5, { now: 100, recentTop: true })).toBe(100);
    expect(keyBetween(undefined, 500, { now: 100, recentTop: true })).toBe(501);
    expect(keyBetween(undefined, undefined, { now: 42, recentTop: false })).toBe(42);
  });
});
