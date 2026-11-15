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
    ({ browser } = await t.adminWithGitHub("queue", "queue/app"));
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

  it("不存在的会话、不存在的排队消息：404", async () => {
    const { shortId } = await running();
    const missing = "00000000-0000-4000-8000-000000000000";

    expect((await browser.post("/api/sessions/nope0000/messages", { text: "x" })).status).toBe(404);
    expect(
      (await browser.post(`/api/sessions/${shortId}/queue/${missing}/withdraw`, {})).status,
    ).toBe(404);
    expect(
      (await browser.post(`/api/sessions/${shortId}/queue/${missing}/send-now`, {})).status,
    ).toBe(404);
  });

  it("Agent 在工作时发消息选 now：直接插进当前回合，不排队；换了模型时照样排队", async () => {
    const { shortId, sessionId, turnId } = await running();
    const res = await browser.post(`/api/sessions/${shortId}/messages`, {
      text: "顺便改个名",
      mode: "now",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ injected: true });
    expect(t.host.last("inject_message")).toMatchObject({ sessionId, turnId, text: "顺便改个名" });
    const all = await events(shortId);
    expect(all.at(-1)).toMatchObject({ type: "user.message", text: "顺便改个名", injected: true });
    expect(all.some((e) => e.type === "message.queued")).toBe(false);

    const switching = await browser.post(`/api/sessions/${shortId}/messages`, {
      text: "下一回合换模型",
      mode: "now",
      effort: "high",
    });
    expect(switching.status).toBe(202);
    expect(await switching.json()).toMatchObject({ queued: { text: "下一回合换模型" } });
  });

  it("停止：回合记成已停止、会话回到等待回复、通知宿主机；没在跑时 409；有排队的消息就用它们开始下一个回合", async () => {
    const { shortId, sessionId, turnId } = await running();
    const stop = () => browser.post(`/api/sessions/${shortId}/stop`, {});
    const res = await stop();
    expect(res.status).toBe(200);
    expect(t.host.last("stop_turn")).toMatchObject({ sessionId, turnId });
    const all = await events(shortId);
    expect(all.some((e) => e.type === "turn.ended" && e.reason === "stopped")).toBe(true);
    const session = (await (await browser.get(`/api/sessions/${shortId}`)).json()) as {
      status: string;
    };
    expect(session.status).toBe("waiting");
    expect((await stop()).status).toBe(409);
    // 停下的回合晚到的事件不再记录
    await t.host.emit({
      type: "agent",
      sessionId,
      turnId,
      event: { type: "message", text: "晚到的" },
    });
    expect((await events(shortId)).some((e) => e.type === "message" && e.text === "晚到的")).toBe(
      false,
    );

    const second = await running();
    await send(second.shortId, "稍后再说");
    const before = startTurns(second.sessionId).length;
    expect((await browser.post(`/api/sessions/${second.shortId}/stop`, {})).status).toBe(200);
    const turnsAfter = startTurns(second.sessionId);
    expect(turnsAfter).toHaveLength(before + 1);
    expect(turnsAfter.at(-1)?.text).toBe("稍后再说");
  });

  it("会话失败以后还能接着发：和唤醒休眠的会话一样，先重新准备沙箱，沙箱好了用这条消息开始回合", async () => {
    const res = await browser.post("/api/sessions", {
      repo: "queue/app",
      baseBranch: "main",
      text: "试试",
    });
    const { shortId } = (await res.json()) as { shortId: string };
    const sessionId = t.host.last("prepare_sandbox").sessionId;
    await t.host.emit({ type: "sandbox.failed", sessionId, error: { code: "internal" } });
    const prepares = t.host.commands.filter((c) => c.type === "prepare_sandbox").length;

    const after = await send(shortId, "再试一次");

    expect(after.status).toBe(202);
    expect(t.host.commands.filter((c) => c.type === "prepare_sandbox")).toHaveLength(prepares + 1);
    await t.host.emit({ type: "sandbox.ready", sessionId });
    expect(t.host.last("start_turn")).toMatchObject({ sessionId, text: "再试一次" });
    const session = (await (await browser.get(`/api/sessions/${shortId}`)).json()) as {
      status: string;
    };
    expect(session.status).toBe("running");
    // 重新准备沙箱的那条状态不属于第 1 个回合（它已经失败了），新回合是第 2 个
    const all = await events(shortId);
    const preparing = all.filter((e) => e.type === "status" && e.detail === "preparing_sandbox");
    expect(preparing.map((e) => e.turn)).toEqual([1, null]);
  });

  it("失败前留下的排队消息点立即发送：同样重新准备沙箱，好了合成回合", async () => {
    const { shortId, sessionId } = await running();
    const queued = (await (await send(shortId, "排着的")).json()) as { queued: { id: string } };
    await t.host.emit({ type: "sandbox.failed", sessionId, error: { code: "internal" } });
    const prepares = t.host.commands.filter((c) => c.type === "prepare_sandbox").length;

    const now = await browser.post(
      `/api/sessions/${shortId}/queue/${queued.queued.id}/send-now`,
      {},
    );

    expect(now.status).toBe(200);
    expect(t.host.commands.filter((c) => c.type === "prepare_sandbox")).toHaveLength(prepares + 1);
    await t.host.emit({ type: "sandbox.ready", sessionId });
    expect(t.host.last("start_turn")).toMatchObject({ sessionId, text: "排着的" });
  });

  it("重新准备沙箱期间点立即发送：消息留在队里，沙箱好了照常合成回合，不丢", async () => {
    const res = await browser.post("/api/sessions", {
      repo: "queue/app",
      baseBranch: "main",
      text: "试试",
    });
    const { shortId } = (await res.json()) as { shortId: string };
    const sessionId = t.host.last("prepare_sandbox").sessionId;
    await t.host.emit({ type: "sandbox.failed", sessionId, error: { code: "internal" } });
    const queued = (await (await send(shortId, "再试一次")).json()) as { queued: { id: string } };

    const now = await browser.post(
      `/api/sessions/${shortId}/queue/${queued.queued.id}/send-now`,
      {},
    );

    expect(now.status).toBe(200);
    await t.host.emit({ type: "sandbox.ready", sessionId });
    expect(t.host.last("start_turn")).toMatchObject({ sessionId, text: "再试一次" });
  });

  it("已归档的会话点立即发送：报会话已归档，消息还留在队里，取消归档以后发消息时一起处理", async () => {
    const { shortId, sessionId } = await running();
    const queued = (await (await send(shortId, "归档前排着的")).json()) as {
      queued: { id: string };
    };
    await browser.post(`/api/sessions/${shortId}/archive`, {});

    const now = await browser.post(
      `/api/sessions/${shortId}/queue/${queued.queued.id}/send-now`,
      {},
    );

    expect(now.status).toBe(409);
    await browser.post(`/api/sessions/${shortId}/unarchive`, {});
    await send(shortId, "接着做");
    await t.host.emit({ type: "sandbox.ready", sessionId });
    expect(t.host.last("start_turn")).toMatchObject({
      sessionId,
      text: "归档前排着的\n\n接着做",
    });
  });
});
