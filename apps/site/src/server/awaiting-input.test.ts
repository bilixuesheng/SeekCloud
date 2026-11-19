import type { SessionEvent, SessionStatusDetail } from "@seekcloud/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";
import { modelUsage, sessions } from "./db/schema";

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

/** 回合正常结束、只有文字时问模型（#140）。判断不出来时退回规则。问的这一次见 sessions/waiting-check.test.ts。 */
describe("回合结束后问模型：是不是在等输入", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp({ waitingCheck: { timeoutMs: 300 } });
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  const start = async (text = "看看首页") => {
    const res = await browser.post("/api/sessions", { repo: "octo/app", baseBranch: "main", text });
    return ((await res.json()) as { shortId: string }).shortId;
  };
  const session = async (id: string) =>
    (await (await browser.get(`/api/sessions/${id}`)).json()) as {
      status: string;
      detail: SessionStatusDetail;
    };
  const detailOf = async (id: string): Promise<SessionStatusDetail> => {
    for (let i = 0; i < 100; i++) {
      await t.host.idle();
      const s = await session(id);
      if (s.detail !== null || s.status !== "waiting") return s.detail;
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };
  const answer = (text: string) =>
    t.model.reply({
      json: {
        id: "msg_upstream_w",
        model: "upstream-internal-model-name",
        content: [{ type: "text", text }],
        usage: { input_tokens: 60, output_tokens: 1 },
      },
    });

  it("模型说是：陈述句也算等你输入；问的是最省的模型、不思考、只要一个词，用量记成 waiting_check", async () => {
    const before = t.model.requests.length;
    answer("是");
    t.host.script({ type: "message", text: "我先按方案 A 改，你看一下再说。" });
    const id = await start();
    expect(await detailOf(id)).toBe("awaiting_input");
    const asked = t.model.requests.slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toMatchObject({
      model: "deepseek-flash",
      stream: false,
      max_tokens: 8,
      thinking: { type: "disabled" },
    });
    expect(JSON.stringify(asked[0]?.body.messages)).toContain("我先按方案 A 改，你看一下再说。");
    const rows = await t.db
      .select()
      .from(modelUsage)
      .where(eq(modelUsage.purpose, "waiting_check"));
    expect(rows.at(-1)).toMatchObject({
      sessionId: (await t.db.select().from(sessions).where(eq(sessions.shortId, id)))[0]?.id,
      turnId: null,
      inputTokens: 60,
      outputTokens: 1,
    });
  });

  it("模型说否：问句也算已完成", async () => {
    answer("否");
    t.host.script({ type: "message", text: "改好了。你要不要先在本地试试？" });
    expect(await detailOf(await start())).toBe("done");
  });

  it("模型出错、答非所问、超时：退回规则；下一个回合照样问", async () => {
    t.model.reply({ status: 500, body: '{"error":"overloaded"}' });
    t.host.script({ type: "message", text: "要把旧的接口一起删掉吗？" });
    expect(await detailOf(await start())).toBe("awaiting_input");

    answer("这个问题很难回答。");
    t.host.script({ type: "message", text: "改好了，测试都过了。" });
    expect(await detailOf(await start())).toBe("done");

    // 一直不回：300 毫秒后按规则判断
    t.model.reply({ stream: [{ event: "ping", data: {} }], hold: true });
    t.host.script({ type: "message", text: "用哪个分支？" });
    expect(await detailOf(await start())).toBe("awaiting_input");
    t.model.release();

    answer("否");
    t.host.script({ type: "message", text: "用哪个分支？" });
    expect(await detailOf(await start())).toBe("done");
  });

  it("没说话、被停止、失败：不问模型", async () => {
    const before = t.model.requests.length;
    t.host.script({ type: "tool.call", callId: "c1", name: "bash", input: { command: "ls" } });
    expect(await detailOf(await start())).toBe("done");
    t.host.script(
      { type: "message", text: "要继续吗？" },
      { type: "turn.ended", reason: "failed", error: { code: "internal" } },
    );
    expect(await detailOf(await start())).toBe("awaiting_input");
    expect(t.model.requests.length).toBe(before);
  });

  it("问模型的时候管理员发了消息、开始了新回合：结果作废", async () => {
    const before = t.model.requests.length;
    t.model.reply({ stream: [{ event: "ping", data: {} }], hold: true });
    t.host.script({ type: "message", text: "要继续吗？" });
    const id = await start();
    // 等回合结束、去问模型了
    for (let i = 0; i < 100 && t.model.requests.length === before; i++) {
      await t.host.idle();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(t.model.requests.length).toBe(before + 1);
    t.host.manual = true;
    try {
      expect((await browser.post(`/api/sessions/${id}/messages`, { text: "继续" })).status).toBe(
        201,
      );
      t.model.release();
      await new Promise((r) => setTimeout(r, 400));
      expect(await session(id)).toMatchObject({ status: "running", detail: null });
    } finally {
      t.host.manual = false;
    }
  });

  it("设置里选了平台调用的模型：问它", async () => {
    const res = await browser.request("/api/settings/platform-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-pro" }),
    });
    expect(res.status).toBe(200);
    answer("否");
    t.host.script({ type: "message", text: "要继续吗？" });
    expect(await detailOf(await start())).toBe("done");
    expect(t.model.requests.at(-1)?.body.model).toBe("deepseek-v4-pro");
  });
});
