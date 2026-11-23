import type { SessionEvent } from "@seekcloud/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

interface SessionBody {
  shortId: string;
  title: string;
  status: string;
}

describe("会话的改名、归档、取消归档、删除", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  /** 发起一个会话，等第一个回合跑完（会话进入等待回复）。 */
  const start = async (text = "把首页的标题改成中文") => {
    const res = await browser.post("/api/sessions", { repo: "octo/app", baseBranch: "main", text });
    expect(res.status).toBe(201);
    await t.host.idle();
    return (await res.json()) as SessionBody;
  };
  const get = async (id: string) => (await browser.get(`/api/sessions/${id}`)).json();
  const events = async (id: string) => {
    const stream = await browser.stream(`/api/sessions/${id}/events`);
    const all: SessionEvent[] = [];
    try {
      for (;;) all.push(JSON.parse((await stream.next(300)).data) as SessionEvent);
    } catch {
      // 读到没有新事件为止
    }
    await stream.close();
    return all;
  };

  it("改名：去掉首尾空格；空的、太长的不收；不动会话在列表里的顺序", async () => {
    const first = await start("第一个");
    t.clock.advance(60_000);
    await start("第二个");
    t.clock.advance(60_000);
    const res = await browser.post(`/api/sessions/${first.shortId}/rename`, {
      title: "  首页改成中文  ",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("首页改成中文");
    expect((await get(first.shortId)).title).toBe("首页改成中文");

    for (const title of ["", "   ", "字".repeat(101)]) {
      const bad = await browser.post(`/api/sessions/${first.shortId}/rename`, { title });
      expect(bad.status).toBe(400);
    }
    // 改名不算"有动静"：第二个会话还在最上面
    const list = (await (await browser.get("/api/sessions")).json()).sessions as SessionBody[];
    expect(list[0]?.title).toBe("第二个");
  });

  it("归档：正在跑的回合停下，告诉宿主机删掉沙箱；不能再发消息；再归档一次不变", async () => {
    t.host.manual = true;
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "跑一个很长的任务",
    });
    const session = (await res.json()) as SessionBody;
    const prepare = t.host.last("prepare_sandbox");
    await t.host.emit({ type: "sandbox.ready", sessionId: prepare.sessionId });
    const turn = t.host.last("start_turn");
    await t.host.emit({
      type: "agent",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      event: { type: "turn.started" },
    });
    t.host.manual = false;

    const archived = await browser.post(`/api/sessions/${session.shortId}/archive`, {});
    expect(archived.status).toBe(200);
    expect((await archived.json()).status).toBe("archived");
    expect(t.host.last("destroy_sandbox").sessionId).toBe(prepare.sessionId);

    const all = await events(session.shortId);
    expect(all.some((e) => e.type === "turn.ended" && e.reason === "stopped")).toBe(true);
    expect(all.at(-1)).toMatchObject({ type: "status", status: "archived" });

    // 宿主机晚到的事件被忽略
    await t.host.emit({
      type: "agent",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      event: { type: "message", text: "晚到的回复" },
    });
    expect((await events(session.shortId)).some((e) => e.type === "message")).toBe(false);

    const send = await browser.post(`/api/sessions/${session.shortId}/messages`, { text: "继续" });
    expect(send.status).toBe(409);

    const destroys = t.host.commands.filter((c) => c.type === "destroy_sandbox").length;
    const again = await browser.post(`/api/sessions/${session.shortId}/archive`, {});
    expect(again.status).toBe(200);
    expect(t.host.commands.filter((c) => c.type === "destroy_sandbox")).toHaveLength(destroys);
  });

  it("取消归档以后会话休眠；发消息就唤醒：先准备沙箱，沙箱好了再开始回合", async () => {
    const session = await start();
    await browser.post(`/api/sessions/${session.shortId}/archive`, {});
    const restored = await browser.post(`/api/sessions/${session.shortId}/unarchive`, {});
    expect(restored.status).toBe(200);
    expect((await restored.json()).status).toBe("dormant");

    const prepares = t.host.commands.filter((c) => c.type === "prepare_sandbox").length;
    t.host.script({ type: "message", text: "接着做完了。" });
    const send = await browser.post(`/api/sessions/${session.shortId}/messages`, { text: "继续" });
    expect(send.status).toBe(202);
    await t.host.idle();

    expect(t.host.commands.filter((c) => c.type === "prepare_sandbox")).toHaveLength(prepares + 1);
    expect(t.host.last("start_turn").text).toBe("继续");
    expect((await get(session.shortId)).status).toBe("waiting");
    const all = await events(session.shortId);
    expect(all.some((e) => e.type === "message" && e.text === "接着做完了。")).toBe(true);
  });

  it("取消归档一个没有归档的会话：不变", async () => {
    const session = await start();
    const res = await browser.post(`/api/sessions/${session.shortId}/unarchive`, {});
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("waiting");
  });

  it("删除：会话和记录都没了，告诉宿主机删掉沙箱；会话列表的推送里说它被删了", async () => {
    const session = await start();
    const list = await browser.stream("/api/sessions/stream");
    await list.next(); // 先发的全部会话

    const res = await browser.post(`/api/sessions/${session.shortId}/delete`, {});
    expect(res.status).toBe(204);
    expect((await browser.get(`/api/sessions/${session.shortId}`)).status).toBe(404);
    expect(await browser.stream(`/api/sessions/${session.shortId}/events`).catch(() => 404)).toBe(
      404,
    );

    const removed = await list.until((e) => e.event === "removed");
    expect(JSON.parse(removed.at(-1)?.data ?? "{}")).toEqual({ shortId: session.shortId });
    await list.close();

    const again = await browser.post(`/api/sessions/${session.shortId}/delete`, {});
    expect(again.status).toBe(404);
  });

  it("会话带着它用的环境的名字（会话信息卡片显示）", async () => {
    const session = await start();
    // 默认环境的名字是空的，界面按语言显示
    expect((await get(session.shortId)).environmentName).toBe("");
  });

  it("置顶：记下置顶的时间，重复置顶不变；不动列表里的顺序；归档时自动取消，已归档的不能置顶", async () => {
    const session = await start("要置顶的");
    const before = (await get(session.shortId)) as { updatedAt: string; pinnedAt: string | null };
    expect(before.pinnedAt).toBeNull();
    t.clock.advance(60_000);
    const pin = (pinned: boolean) =>
      browser.post(`/api/sessions/${session.shortId}/pin`, { pinned });
    const pinned = (await (await pin(true)).json()) as { updatedAt: string; pinnedAt: string };
    expect(pinned.pinnedAt).toBe(t.clock.now().toISOString());
    expect(pinned.updatedAt).toBe(before.updatedAt);
    t.clock.advance(60_000);
    expect(((await (await pin(true)).json()) as { pinnedAt: string }).pinnedAt).toBe(
      pinned.pinnedAt,
    );
    expect(((await (await pin(false)).json()) as { pinnedAt: null }).pinnedAt).toBeNull();

    await pin(true);
    await browser.post(`/api/sessions/${session.shortId}/archive`, {});
    expect(((await get(session.shortId)) as { pinnedAt: null }).pinnedAt).toBeNull();
    const refused = await pin(true);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "session_archived",
    );
    // 已归档的取消置顶不报错
    expect((await pin(false)).status).toBe(200);
  });

  it("置顶消息：只能置顶 Agent 的回复，带一个短标题；重复置顶不变；能取消；按先后排", async () => {
    const session = await start("看看测试");
    const all = await events(session.shortId);
    const reply = all.find((e) => e.type === "message");
    const user = all.find((e) => e.type === "user.message");
    expect(reply).toBeDefined();
    const pin = (seq: number, pinned = true) =>
      browser.post(`/api/sessions/${session.shortId}/pins`, { seq, pinned });

    const res = await pin(reply?.seq as number);
    expect(res.status).toBe(200);
    const { pins } = (await res.json()) as { pins: { seq: number; title: string }[] };
    expect(pins).toHaveLength(1);
    expect(pins[0]?.seq).toBe(reply?.seq);
    expect(pins[0]?.title.length).toBeGreaterThan(0);
    expect(pins[0]?.title.length).toBeLessThanOrEqual(21);

    expect(
      ((await (await pin(reply?.seq as number)).json()) as { pins: unknown[] }).pins,
    ).toHaveLength(1);
    const listed = await browser.get(`/api/sessions/${session.shortId}/pins`);
    expect(((await listed.json()) as { pins: unknown[] }).pins).toHaveLength(1);

    // 用户的消息、不存在的序号都不行
    expect((await pin(user?.seq as number)).status).toBe(404);
    expect((await pin(9999)).status).toBe(404);

    expect(
      ((await (await pin(reply?.seq as number, false)).json()) as { pins: unknown[] }).pins,
    ).toEqual([]);
  });

  it("有新内容：回合结束时没人开着会话就标上；开着的不标；能手动标已读、未读", async () => {
    // 没人开着：第一个回合跑完就是有新内容
    const away = await start("没人看着");
    expect(((await get(away.shortId)) as { unread: boolean }).unread).toBe(true);
    const read = await browser.post(`/api/sessions/${away.shortId}/read`, { unread: false });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { unread: boolean }).unread).toBe(false);

    // 开着会话页（事件流开着）时回合结束：不标
    const stream = await browser.stream(`/api/sessions/${away.shortId}/events`);
    await browser.post(`/api/sessions/${away.shortId}/messages`, { text: "再来一次" });
    await t.host.idle();
    expect(((await get(away.shortId)) as { unread: boolean }).unread).toBe(false);
    await stream.close();

    // 菜单里手动标未读
    const marked = await browser.post(`/api/sessions/${away.shortId}/read`, { unread: true });
    expect(((await marked.json()) as { unread: boolean }).unread).toBe(true);
  });

  it("没登录、别人的会话都不行", async () => {
    const session = await start();
    const stranger = t.browser();
    for (const action of ["rename", "archive", "unarchive", "pin", "pins", "read"]) {
      const res = await stranger.post(`/api/sessions/${session.shortId}/${action}`, {
        title: "x",
        pinned: true,
        seq: 1,
        unread: true,
      });
      expect(res.status).toBe(401);
    }
    expect((await stranger.post(`/api/sessions/${session.shortId}/delete`, {})).status).toBe(401);
    for (const action of ["rename", "archive", "unarchive", "delete", "pin", "read"]) {
      const res = await browser.post(`/api/sessions/nosuchid/${action}`, {
        title: "x",
        pinned: true,
        unread: true,
      });
      expect(res.status).toBe(404);
    }
  });
});

describe("会话很多时的列表", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("many", "many/app"));
    t.host.manual = true;
  });
  afterAll(() => t.close());

  it("置顶的会话再久没动也在列表里，不被最近的 200 个挤掉", async () => {
    const start = async (text: string) => {
      const res = await browser.post("/api/sessions", {
        repo: "many/app",
        baseBranch: "main",
        text,
      });
      return (await res.json()) as SessionBody;
    };
    const pinned = await start("很久以前置顶的");
    await browser.post(`/api/sessions/${pinned.shortId}/pin`, { pinned: true });
    const old = await start("很久以前没置顶的");
    for (let i = 0; i < 200; i++) {
      t.clock.advance(1000);
      await start(`后来的第 ${i + 1} 个`);
    }

    const { sessions } = (await (await browser.get("/api/sessions")).json()) as {
      sessions: SessionBody[];
    };

    expect(sessions).toHaveLength(201);
    expect(sessions.at(-1)?.shortId).toBe(pinned.shortId);
    expect(sessions.some((s) => s.shortId === old.shortId)).toBe(false);
  }, 60_000);
});
