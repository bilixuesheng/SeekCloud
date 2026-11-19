import type { SessionStatusDetail } from "@seekcloud/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";
import { modelUsage } from "./db/schema";

/** 置顶消息的短标题问模型（#140 里一起换的）：模型给不出来用规则。规则和整理回答见 sessions/pin-title.test.ts。 */
describe("置顶消息的短标题：问模型", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp({ platformCalls: { timeoutMs: 300 } });
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  /** 起一个会话，等回合结束、判断完是否在等输入（那次调用也走假模型），返回 Agent 回复的序号。 */
  const replied = async (text: string) => {
    t.host.script({ type: "message", text });
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "看看",
    });
    const { shortId } = (await res.json()) as { shortId: string };
    for (let i = 0; i < 100; i++) {
      await t.host.idle();
      const s = (await (await browser.get(`/api/sessions/${shortId}`)).json()) as {
        detail: SessionStatusDetail;
      };
      if (s.detail !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const stream = await browser.stream(`/api/sessions/${shortId}/events`);
    const events = (await stream.until((e) => JSON.parse(e.data).type === "message")).map(
      (e) => JSON.parse(e.data) as { type: string; seq: number },
    );
    await stream.close();
    const seq = events.find((e) => e.type === "message")?.seq as number;
    const pin = async () => {
      const r = await browser.post(`/api/sessions/${shortId}/pins`, { seq, pinned: true });
      return ((await r.json()) as { pins: Array<{ title: string }> }).pins;
    };
    return { pin };
  };
  const answer = (text: string) =>
    t.model.reply({
      json: {
        id: "msg_upstream_p",
        model: "upstream-internal-model-name",
        content: [{ type: "text", text }],
        usage: { input_tokens: 90, output_tokens: 6 },
      },
    });

  it("模型起的标题：整理过再存；用量记一条 pin_title；重复置顶不再问", async () => {
    const { pin } = await replied("## 改了什么\n首页的标题改成中文了。");
    answer("标题：首页标题改成中文。");
    expect((await pin())[0]?.title).toBe("首页标题改成中文");
    const rows = await t.db.select().from(modelUsage).where(eq(modelUsage.purpose, "pin_title"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 90, outputTokens: 6 });
    expect(t.model.requests.at(-1)?.body).toMatchObject({
      max_tokens: 32,
      thinking: { type: "disabled" },
    });
    const before = t.model.requests.length;
    expect((await pin())[0]?.title).toBe("首页标题改成中文");
    expect(t.model.requests.length).toBe(before);
  });

  it("模型出错、回答是空的、超时：用规则取", async () => {
    const failed = await replied("## 补上测试\n加了三个测试。");
    t.model.reply({ status: 500, body: '{"error":"overloaded"}' });
    expect((await failed.pin())[0]?.title).toBe("补上测试");

    const empty = await replied("## 换了端口\n改成 8080。");
    answer("   ");
    expect((await empty.pin())[0]?.title).toBe("换了端口");

    const slow = await replied("## 删了旧接口\n删掉了。");
    t.model.reply({ stream: [{ event: "ping", data: {} }], hold: true });
    expect((await slow.pin())[0]?.title).toBe("删了旧接口");
    t.model.release();
  });
});
