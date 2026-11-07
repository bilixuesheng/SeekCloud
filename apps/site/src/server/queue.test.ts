import type { HostCommand, SessionEvent } from "@seekcloud/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamedEvent } from "../testing/event-stream";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const parse = (e: StreamedEvent) => JSON.parse(e.data) as SessionEvent;

/** Agent 工作时发消息：排队、撤回、立即发送，回合结束后自动开始下一回合。 */
describe("Agent 工作时发消息", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.signUpWithGitHub("queue", "queue/app"));
    t.host.manual = true;
  });
  afterAll(() => t.close());

  /** 发起一个会话，沙箱准备好，第一个回合开始运行。 */
  async function running() {
    const res = await browser.post("/api/sessions", {
      repo: "queue/app",
      baseBranch: "main",
      text: "第一件事",
    });
    const { shortId } = (await res.json()) as { shortId: string };
    const sessionId = t.host.last("prepare_sandbox").sessionId;
    await t.host.emit({ type: "sandbox.ready", sessionId });
    const turnId = t.host.last("start_turn").turnId;
    return { shortId, sessionId, turnId };
  }

  const send = (shortId: string, text: string) =>
    browser.post(`/api/sessions/${shortId}/messages`, { text });

  const endTurn = (sessionId: string, turnId: string, reason = "completed" as const) =>
    t.host.emit({ type: "agent", sessionId, turnId, event: { type: "turn.ended", reason } });

  /** 会话到现在为止的全部事件（读到 seq 不再增长）。 */
  async function events(shortId: string) {
    const stream = await browser.stream(`/api/sessions/${shortId}/events`);
    const all: SessionEvent[] = [];
    for (;;) {
      try {
        all.push(parse(await stream.next(150)));
      } catch {
        break;
      }
    }
    await stream.close();
    return all;
  }

  const startTurns = (sessionId: string) =>
    t.host.commands.filter(
      (c): c is Extract<HostCommand, { type: "start_turn" }> =>
        c.type === "start_turn" && c.sessionId === sessionId,
    );

  it("排队的消息在回合结束后合成下一回合的开头，按发的顺序", async () => {
    const { shortId, sessionId, turnId } = await running();
    const first = await send(shortId, "顺便把按钮改成蓝色");
    const second = await send(shortId, "还有标题加粗");
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(startTurns(sessionId)).toHaveLength(1);

    await endTurn(sessionId, turnId);

    const turns = startTurns(sessionId);
    expect(turns).toHaveLength(2);
    expect(turns[1]?.text).toBe("顺便把按钮改成蓝色\n\n还有标题加粗");
    const all = await events(shortId);
    const queued = all.filter((e) => e.type === "message.queued");
    expect(queued.map((e) => e.type === "message.queued" && e.text)).toEqual([
      "顺便把按钮改成蓝色",
      "还有标题加粗",
    ]);
    expect(all.at(-2)).toMatchObject({
      type: "user.message",
      text: "顺便把按钮改成蓝色\n\n还有标题加粗",
      queued: queued.map((e) => e.type === "message.queued" && e.id),
    });
    expect(all.at(-1)).toMatchObject({ type: "status", status: "running" });
  });

  it("撤回：原文还给浏览器，回合结束后不会再发", async () => {
    const { shortId, sessionId, turnId } = await running();
    const queued = (await (await send(shortId, "算了不用了")).json()) as {
      queued: { id: string };
    };

    const withdraw = await browser.post(
      `/api/sessions/${shortId}/queue/${queued.queued.id}/withdraw`,
      {},
    );
    expect(withdraw.status).toBe(200);
    expect(await withdraw.json()).toEqual({ text: "算了不用了" });
    await endTurn(sessionId, turnId);

    expect(startTurns(sessionId)).toHaveLength(1);
    const all = await events(shortId);
    expect(all.some((e) => e.type === "message.withdrawn")).toBe(true);
    expect(all.at(-1)).toMatchObject({ type: "status", status: "waiting" });
    // 已经撤回的再撤回：404。
    const again = await browser.post(
      `/api/sessions/${shortId}/queue/${queued.queued.id}/withdraw`,
      {},
    );
    expect(again.status).toBe(404);
  });

  it("立即发送：宿主机收到插话，Agent 在当前回合读到；回合结束后不再重复发", async () => {
    const { shortId, sessionId, turnId } = await running();
    const queued = (await (await send(shortId, "先别改数据库")).json()) as {
      queued: { id: string };
    };

    const now = await browser.post(
      `/api/sessions/${shortId}/queue/${queued.queued.id}/send-now`,
      {},
    );

    expect(now.status).toBe(200);
    expect(t.host.last("inject_message")).toEqual({
      type: "inject_message",
      sessionId,
      turnId,
      text: "先别改数据库",
    });
    await endTurn(sessionId, turnId);
    expect(startTurns(sessionId)).toHaveLength(1);
    const all = await events(shortId);
    expect(all.find((e) => e.type === "user.message" && e.injected)).toMatchObject({
      text: "先别改数据库",
      injected: true,
    });
  });

  it("沙箱还在准备时立即发送：直接并进这个回合的输入", async () => {
    const res = await browser.post("/api/sessions", {
      repo: "queue/app",
      baseBranch: "main",
      text: "加个登录页",
    });
    const { shortId } = (await res.json()) as { shortId: string };
    const sessionId = t.host.last("prepare_sandbox").sessionId;
    const queued = (await (await send(shortId, "用 Tailwind")).json()) as {
      queued: { id: string };
    };

    await browser.post(`/api/sessions/${shortId}/queue/${queued.queued.id}/send-now`, {});
    await t.host.emit({ type: "sandbox.ready", sessionId });

    expect(startTurns(sessionId)[0]?.text).toBe("加个登录页\n\n用 Tailwind");
  });

  it("别人的会话、别人的排队消息：404", async () => {
    const { shortId } = await running();
    const queued = (await (await send(shortId, "私事")).json()) as { queued: { id: string } };
    const { browser: other } = await t.signUpWithGitHub("queue-other", "queue-other/app");

    expect((await other.post(`/api/sessions/${shortId}/messages`, { text: "x" })).status).toBe(404);
    expect(
      (await other.post(`/api/sessions/${shortId}/queue/${queued.queued.id}/withdraw`, {})).status,
    ).toBe(404);
  });

  it("会话已经失败：不能再发", async () => {
    const res = await browser.post("/api/sessions", {
      repo: "queue/app",
      baseBranch: "main",
      text: "试试",
    });
    const { shortId } = (await res.json()) as { shortId: string };
    const sessionId = t.host.last("prepare_sandbox").sessionId;
    await t.host.emit({ type: "sandbox.failed", sessionId, error: { code: "internal" } });

    const after = await send(shortId, "再试一次");

    expect(after.status).toBe(409);
  });
});
