import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoOutcome, SessionEvent } from "@seekcloud/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamedEvent } from "../testing/event-stream";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const parse = (e: StreamedEvent) => JSON.parse(e.data) as SessionEvent;
const HEAD = "a".repeat(40);

const outcome = (push: RepoOutcome["push"], error?: string): RepoOutcome => ({
  fullName: "octo/app",
  head: HEAD,
  push,
  ...(error && { error }),
  files: [{ path: "index.html", additions: 3, deletions: 1 }],
});

describe("回合结束时整理工作区的结果（#27）", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  const start = async (text = "把首页的标题改成中文") => {
    const res = await browser.post("/api/sessions", { repo: "octo/app", baseBranch: "main", text });
    return ((await res.json()) as { shortId: string }).shortId;
  };
  /** 会话从头到现在的全部事件：读到第 waits 个"等待回复"为止（每次停下来等管理员都有一个）。 */
  const events = async (id: string, waits = 1) => {
    await t.host.idle();
    const stream = await browser.stream(`/api/sessions/${id}/events`);
    let seen = 0;
    const all = (
      await stream.until((e) => {
        const ev = parse(e);
        // 回合结束时的那条（判断完补的附加说明是另一条，#139）
        if (ev.type === "status" && ev.status === "waiting" && ev.detail === null) seen++;
        return seen >= waits;
      })
    ).map(parse);
    await stream.close();
    return all;
  };

  it("workspace 记在回合里、turn.ended 前面（检查点）；开始回合带上回合序号", async () => {
    t.host.script(
      { type: "message", text: "改好了" },
      { type: "workspace", repos: [outcome("pushed")] },
    );
    const id = await start();
    const all = await events(id);
    expect(t.host.last("start_turn")).toMatchObject({ turnNumber: 1 });
    const at = all.findIndex((e) => e.type === "workspace");
    expect(all[at]).toMatchObject({ turn: 1, repos: [{ fullName: "octo/app", head: HEAD }] });
    expect(all[at + 1]).toMatchObject({ type: "turn.ended", reason: "completed" });

    await browser.post(`/api/sessions/${id}/messages`, { text: "再改一下" });
    await t.host.idle();
    expect(t.host.last("start_turn")).toMatchObject({ turnNumber: 2 });
  });

  it("推送失败：自动开跟进回合，把 git 的原话交给 Agent；同一条消息最多跟进 2 次，之后告诉管理员", async () => {
    const rejected = "! [rejected] seekcloud/x -> seekcloud/x (fetch first)";
    for (let i = 0; i < 3; i++) {
      t.host.script({ type: "workspace", repos: [outcome("failed", rejected)] });
    }
    const before = t.host.commands.filter((c) => c.type === "start_turn").length;
    const id = await start("改个标题");
    const all = await events(id);
    const turns = t.host.commands.filter((c) => c.type === "start_turn").slice(before);
    expect(turns).toHaveLength(3);
    expect(turns[1]).toMatchObject({ turnNumber: 2 });
    expect(turns[1]?.type === "start_turn" && turns[1].text).toContain(rejected);
    const followUps = all.filter((e) => e.type === "user.message" && e.followUp === "push_failed");
    expect(followUps.map((e) => e.turn)).toEqual([2, 3]);
    expect(all.filter((e) => e.type === "push.gave_up")).toEqual([
      expect.objectContaining({ turn: 3, repos: ["octo/app"] }),
    ]);

    // 管理员再发一条：又能跟进 2 次（按管理员的消息算）
    t.host.script({ type: "workspace", repos: [outcome("failed", rejected)] });
    t.host.script({ type: "workspace", repos: [outcome("pushed")] });
    await browser.post(`/api/sessions/${id}/messages`, { text: "再试试" });
    const after = await events(id, 2);
    expect(after.filter((e) => e.type === "user.message" && e.followUp)).toHaveLength(3);
    expect(after.filter((e) => e.type === "push.gave_up")).toHaveLength(1);
  });

  it("跟进一次就推上去了：不再跟进", async () => {
    t.host.script({ type: "workspace", repos: [outcome("failed", "网络断了")] });
    t.host.script({ type: "workspace", repos: [outcome("pushed")] });
    const id = await start("改个按钮");
    const all = await events(id);
    expect(all.filter((e) => e.type === "user.message" && e.followUp)).toHaveLength(1);
    expect(all.filter((e) => e.type === "push.gave_up")).toEqual([]);
  });

  it("回合被停止：宿主机晚到的 workspace 照样记下（只记一次），推送失败也不跟进", async () => {
    t.host.manual = true;
    try {
      const id = await start("慢慢改");
      await t.host.emit({
        type: "sandbox.ready",
        sessionId: t.host.last("prepare_sandbox").sessionId,
      });
      const turn = t.host.last("start_turn");
      await t.host.emit({
        type: "agent",
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        event: { type: "turn.started" },
      });
      expect((await browser.post(`/api/sessions/${id}/stop`, {})).status).toBe(200);
      const late = {
        type: "agent" as const,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        event: { type: "workspace" as const, repos: [outcome("failed", "被拒")] },
      };
      await t.host.emit(late);
      await t.host.emit(late);
      await t.host.emit({ ...late, event: { type: "turn.ended", reason: "stopped" } });
      await t.host.idle();
      // 停止时就变成了等待回复；再发一条消息、跑完，读到第二个等待回复，晚到的都在里面
      await browser.post(`/api/sessions/${id}/messages`, { text: "好了" });
      const next = t.host.last("start_turn");
      await t.host.emit({ ...late, turnId: next.turnId, event: { type: "turn.started" } });
      await t.host.emit({
        ...late,
        turnId: next.turnId,
        event: { type: "turn.ended", reason: "completed" },
      });
      const all = await events(id, 2);
      expect(all.filter((e) => e.type === "workspace")).toHaveLength(1);
      expect(all.filter((e) => e.type === "user.message" && e.followUp)).toEqual([]);
      // 只有停止的那个回合和管理员后来发的那个，没有跟进回合
      expect(
        t.host.commands.filter((c) => c.type === "start_turn" && c.sessionId === turn.sessionId),
      ).toHaveLength(2);
    } finally {
      t.host.manual = false;
    }
  });

  it("管理员在回合里排了消息、回合推送失败：先跟进，跟进回合结束后再处理排队的消息", async () => {
    t.host.manual = true;
    try {
      const id = await start("加个页脚");
      await t.host.emit({
        type: "sandbox.ready",
        sessionId: t.host.last("prepare_sandbox").sessionId,
      });
      const first = t.host.last("start_turn");
      const agent = (turnId: string, event: object) =>
        t.host.emit({ type: "agent", sessionId: first.sessionId, turnId, event } as never);
      await agent(first.turnId, { type: "turn.started" });
      expect(
        (await browser.post(`/api/sessions/${id}/messages`, { text: "页脚用灰色" })).status,
      ).toBe(202);
      await agent(first.turnId, { type: "workspace", repos: [outcome("failed", "被拒")] });
      await agent(first.turnId, { type: "turn.ended", reason: "completed" });
      const followUp = t.host.last("start_turn");
      expect(followUp.turnId).not.toBe(first.turnId);
      expect(followUp.text).toContain("推送会话分支失败");

      await agent(followUp.turnId, { type: "turn.started" });
      await agent(followUp.turnId, { type: "workspace", repos: [outcome("pushed")] });
      await agent(followUp.turnId, { type: "turn.ended", reason: "completed" });
      expect(t.host.last("start_turn").text).toBe("页脚用灰色");
    } finally {
      t.host.manual = false;
    }
  });

  it("对比基础分支的 diff（改动面板）：每个仓库只留最新的，补发来的旧回合的不盖新的；不是这个会话的回合不收", async () => {
    t.host.manual = true;
    try {
      const id = await start("改个样式");
      const sessionId = t.host.last("prepare_sandbox").sessionId;
      await t.host.emit({ type: "sandbox.ready", sessionId });
      const first = t.host.last("start_turn");
      const diff = (turnId: string, patch: string) =>
        t.host.emit({
          type: "workspace.diff",
          sessionId,
          turnId,
          repos: [
            {
              fullName: "octo/app",
              baseBranch: "main",
              base: "b".repeat(40),
              head: HEAD,
              files: [{ path: "a.css", additions: 1, deletions: 0, patch }],
            },
          ],
        });
      expect(await (await browser.get(`/api/sessions/${id}/diff`)).json()).toEqual({ repos: [] });
      await t.host.emit({
        type: "agent",
        sessionId,
        turnId: first.turnId,
        event: { type: "turn.started" },
      });
      await t.host.emit({
        type: "agent",
        sessionId,
        turnId: first.turnId,
        event: { type: "turn.ended", reason: "completed" },
      });
      await diff(first.turnId, "第一回合");
      await browser.post(`/api/sessions/${id}/messages`, { text: "再改" });
      await t.host.idle();
      const second = t.host.last("start_turn");
      await diff(second.turnId, "第二回合");
      await diff(first.turnId, "补发来的第一回合");
      await diff(randomUUID(), "别的回合");
      await diff("not-a-uuid", "乱写的");
      await t.host.idle();
      const body = (await (await browser.get(`/api/sessions/${id}/diff`)).json()) as {
        repos: Array<{ fullName: string; files: Array<{ patch?: string }> }>;
      };
      expect(body.repos.map((r) => [r.fullName, r.files[0]?.patch])).toEqual([
        ["octo/app", "第二回合"],
      ]);
    } finally {
      t.host.manual = false;
    }
  });

  it("Agent 的会话文件：存下来，唤醒时准备沙箱的命令带回去；格式不对、别的会话的回合发来的不存；删会话时一起删", async () => {
    t.host.script({ type: "message", text: "好了" });
    const id = await start("记住这次对话");
    await t.host.idle();
    const turn = t.host.last("start_turn");
    const archive = Buffer.from("假的 tar.gz").toString("base64");
    const file = join(t.dataDir, "agent-sessions", `${turn.sessionId}.tar.gz`);
    await t.host.emit({
      type: "agent.archive",
      sessionId: turn.sessionId,
      turnId: randomUUID(),
      data: archive,
    });
    await t.host.emit({
      type: "agent.archive",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      data: "不是 base64!",
    });
    await t.host.idle();
    expect(existsSync(file)).toBe(false);
    await t.host.emit({
      type: "agent.archive",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      data: archive,
    });
    await t.host.idle();
    expect(readFileSync(file).toString()).toBe("假的 tar.gz");

    // 休眠以后（归档再取消归档）发消息唤醒：重新准备沙箱，带上会话文件
    expect((await browser.post(`/api/sessions/${id}/archive`, {})).status).toBe(200);
    expect((await browser.post(`/api/sessions/${id}/unarchive`, {})).status).toBe(200);
    await browser.post(`/api/sessions/${id}/messages`, { text: "接着来" });
    await t.host.idle();
    expect(t.host.last("prepare_sandbox")).toMatchObject({
      sessionId: turn.sessionId,
      agentArchive: archive,
    });

    expect((await browser.post(`/api/sessions/${id}/delete`, {})).status).toBe(204);
    expect(existsSync(file)).toBe(false);
  });
});
