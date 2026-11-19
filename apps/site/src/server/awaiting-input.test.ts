import type { SessionEvent, SessionStatusDetail } from "@seekcloud/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

/** 回合结束以后"等你输入"还是"已完成"（#139）：会话编排这一半。规则本身见 sessions/awaiting-input.test.ts。 */
describe("回合结束后的附加说明：等你输入、已完成", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  const start = async (text = "看看首页") => {
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text,
    });
    return ((await res.json()) as { shortId: string }).shortId;
  };
  /** 判断在后台做：等到附加说明出来（或者确定不会出来）。 */
  const detailOf = async (id: string, wait = true): Promise<SessionStatusDetail> => {
    for (let i = 0; i < 50; i++) {
      await t.host.idle();
      const session = (await (await browser.get(`/api/sessions/${id}`)).json()) as {
        status: string;
        detail: SessionStatusDetail;
      };
      if (!wait || session.detail !== null || session.status !== "waiting") return session.detail;
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };
  const statusEvents = async (id: string, count: number) => {
    const stream = await browser.stream(`/api/sessions/${id}/events`);
    let seen = 0;
    const all = (
      await stream.until((e) => {
        const ev = JSON.parse(e.data) as SessionEvent;
        if (ev.type === "status" && ev.status === "waiting") seen++;
        return seen >= count;
      })
    ).map((e) => JSON.parse(e.data) as SessionEvent);
    await stream.close();
    return all.filter((e) => e.type === "status");
  };

  it("最后一条回复是问句：等你输入；先是不带说明的等待回复，判断完再补一条", async () => {
    t.host.script(
      { type: "message", text: "我看了一下。" },
      { type: "message", text: "要把旧的接口一起删掉吗？" },
    );
    const id = await start();
    expect(await detailOf(id)).toBe("awaiting_input");
    const waits = (await statusEvents(id, 2)).filter(
      (e) => e.type === "status" && e.status === "waiting",
    );
    expect(waits.map((e) => e.type === "status" && e.detail)).toEqual([null, "awaiting_input"]);
  });

  it("陈述句：已完成；被停止：已完成；回合失败：等你输入", async () => {
    t.host.script({ type: "message", text: "改好了，测试都过了。" });
    expect(await detailOf(await start())).toBe("done");

    t.host.script(
      { type: "message", text: "要继续吗？" },
      { type: "turn.ended", reason: "failed", error: { code: "internal" } },
    );
    expect(await detailOf(await start())).toBe("awaiting_input");

    t.host.manual = true;
    try {
      const id = await start("慢慢来");
      const prepare = t.host.last("prepare_sandbox");
      await t.host.emit({ type: "sandbox.ready", sessionId: prepare.sessionId });
      const turn = t.host.last("start_turn");
      await t.host.emit({
        type: "agent",
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        event: { type: "message", text: "要我继续吗？" },
      });
      expect((await browser.post(`/api/sessions/${id}/stop`, {})).status).toBe(200);
      expect(await detailOf(id)).toBe("done");
    } finally {
      t.host.manual = false;
    }
  });

  it("回合结束时有排队的消息：直接开始下一个回合，不判断；发消息开始新回合时附加说明清掉", async () => {
    t.host.manual = true;
    let id: string;
    try {
      id = await start("改两处");
      const prepare = t.host.last("prepare_sandbox");
      await t.host.emit({ type: "sandbox.ready", sessionId: prepare.sessionId });
      const turn = t.host.last("start_turn");
      const agent = (event: object) =>
        t.host.emit({
          type: "agent",
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          event,
        } as never);
      await agent({ type: "turn.started" });
      expect(
        (await browser.post(`/api/sessions/${id}/messages`, { text: "顺便改标题" })).status,
      ).toBe(202);
      await agent({ type: "message", text: "要不要改？" });
      await agent({ type: "turn.ended", reason: "completed" });
      // 排队的消息开始了下一个回合：还在运行，没有附加说明
      const session = (await (await browser.get(`/api/sessions/${id}`)).json()) as {
        status: string;
        detail: SessionStatusDetail;
      };
      expect(session).toMatchObject({ status: "running", detail: null });
    } finally {
      t.host.manual = false;
    }

    // 等你输入的会话：管理员一回话，附加说明就清掉（新回合是运行中、没有说明）
    t.host.script({ type: "message", text: "用哪个分支？" });
    const asking = await start("问我点什么");
    expect(await detailOf(asking)).toBe("awaiting_input");
    t.host.manual = true;
    try {
      await browser.post(`/api/sessions/${asking}/messages`, { text: "用 main" });
      expect(await detailOf(asking, false)).toBe(null);
    } finally {
      t.host.manual = false;
    }
  });
});
