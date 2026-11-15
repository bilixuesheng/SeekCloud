import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

describe("模型进度：只推送、不落库", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  it("正在跑的回合的进度原样推给打开着会话的浏览器；不存下来，重连也不补；别的回合的丢掉", async () => {
    t.host.manual = true;
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "想一想再改",
    });
    const { shortId } = (await res.json()) as { shortId: string };
    const prepare = t.host.last("prepare_sandbox");
    await t.host.emit({ type: "sandbox.ready", sessionId: prepare.sessionId });
    const turn = t.host.last("start_turn");

    const stream = await browser.stream(`/api/sessions/${shortId}/events`);
    await stream.until((e) => e.event === "session" && JSON.parse(e.data).type === "status");

    await t.host.emit({
      type: "progress",
      sessionId: turn.sessionId,
      turnId: "not-this-turn",
      phase: "thinking",
      tokens: 999,
    });
    await t.host.emit({
      type: "progress",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      phase: "thinking",
      tokens: 128,
    });
    const got = await stream.until((e) => e.event === "progress");
    const progress = got.filter((e) => e.event === "progress");
    expect(progress.map((e) => JSON.parse(e.data))).toEqual([{ phase: "thinking", tokens: 128 }]);
    expect(progress[0]?.id).toBeUndefined();
    await stream.close();

    // 重新打开：只有落库的事件，没有进度
    const again = await browser.stream(`/api/sessions/${shortId}/events`);
    const replay: { event?: string }[] = [];
    try {
      for (;;) replay.push(await again.next(300));
    } catch {
      // 读到没有新事件为止
    }
    await again.close();
    expect(replay.length).toBeGreaterThan(0);
    expect(replay.some((e) => e.event === "progress")).toBe(false);
    t.host.manual = false;
  });
});
