import type { SessionEvent, SessionEventBody } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";
import { buildTimeline, summarizeTools, toolSummary } from "./timeline";

const events = (...bodies: SessionEventBody[]): SessionEvent[] =>
  bodies.map((body, i) => ({ seq: i + 1, at: "2026-10-31T00:00:00Z", turn: 1, ...body }));

describe("会话事件整理成界面内容", () => {
  it("排队的消息：撤回的拿掉；合成下一回合或立即发送以后变成普通的用户消息", () => {
    const timeline = buildTimeline(
      events(
        { type: "message.queued", id: "q1", text: "改成蓝色" },
        { type: "message.queued", id: "q2", text: "算了" },
        { type: "message.queued", id: "q3", text: "先别动数据库" },
        { type: "message.withdrawn", id: "q2" },
        { type: "user.message", text: "先别动数据库", injected: true, queued: ["q3"] },
      ),
    );
    expect(timeline.queued).toEqual([{ id: "q1", text: "改成蓝色" }]);
    expect(timeline.items.map((i) => i.kind === "user" && i.text)).toEqual(["先别动数据库"]);

    const next = buildTimeline(
      events(
        { type: "message.queued", id: "q1", text: "改成蓝色" },
        { type: "user.message", text: "改成蓝色", queued: ["q1"] },
      ),
    );
    expect(next.queued).toEqual([]);
  });

  it("用户消息在回合开始后才算交给 Agent；排队、准备沙箱时还没有；插话当场就算", () => {
    const delivered = (...bodies: SessionEventBody[]) =>
      buildTimeline(events(...bodies)).items.flatMap((i) =>
        i.kind === "user" ? [i.delivered] : [],
      );
    // 刚发起会话，还在排队或准备沙箱
    expect(
      delivered(
        { type: "user.message", text: "改标题" },
        { type: "status", status: "running", detail: "preparing_sandbox" },
      ),
    ).toEqual([false]);
    expect(delivered({ type: "user.message", text: "改标题" }, { type: "turn.started" })).toEqual([
      true,
    ]);
    // 下一回合的消息要等下一次回合开始
    expect(
      delivered(
        { type: "user.message", text: "改标题" },
        { type: "turn.started" },
        { type: "turn.ended", reason: "completed" },
        { type: "user.message", text: "再改一下" },
      ),
    ).toEqual([true, false]);
    expect(
      delivered(
        { type: "user.message", text: "改标题" },
        { type: "turn.started" },
        { type: "user.message", text: "先别动数据库", injected: true },
      ),
    ).toEqual([true, true]);
  });

  it("回合结束后，最后一条回复带上这个回合的全部回复，给复制用；没结束的回合没有", () => {
    const timeline = buildTimeline(
      events(
        { type: "user.message", text: "改标题" },
        { type: "turn.started" },
        { type: "message", text: "我先看看代码。" },
        { type: "tool.call", callId: "c1", name: "Read", input: { path: "a.ts" } },
        { type: "message", text: "改好了。" },
        { type: "turn.ended", reason: "completed" },
        { type: "user.message", text: "再改一下" },
        { type: "turn.started" },
        { type: "message", text: "第二个回合。" },
      ),
    );
    const replies = timeline.items.flatMap((i) => (i.kind === "assistant" ? [i] : []));
    expect(replies.map((r) => r.turnEnd?.reply)).toEqual([
      undefined,
      "我先看看代码。\n\n改好了。",
      undefined,
    ]);
    expect(replies[1]?.turnEnd?.at).toBe("2026-10-31T00:00:00Z");
  });

  it("连续的工具调用合成一组；结果接到对应的调用上，还没结果的显示为进行中", () => {
    const { items } = buildTimeline(
      events(
        { type: "tool.call", callId: "a", name: "Read", input: { file_path: "a.ts" } },
        { type: "tool.call", callId: "b", name: "Bash", input: { command: "ls" } },
        { type: "tool.result", callId: "a", output: "内容", isError: false },
      ),
    );
    expect(items).toHaveLength(1);
    const group = items[0] as Extract<(typeof items)[number], { kind: "tools" }>;
    expect(group.calls[0]).toMatchObject({
      name: "Read",
      result: { output: "内容", isError: false },
    });
    expect(group.calls[1]).toMatchObject({ name: "Bash" });
    expect(group.calls[1]).not.toHaveProperty("result");
    expect(summarizeTools(group.calls)).toBe("读取了 1 个文件，运行了 1 条命令");
  });

  it("待办清单只保留最新的整表；状态取最后一条", () => {
    const timeline = buildTimeline(
      events(
        { type: "todo", items: [{ content: "一", status: "in_progress" }] },
        { type: "status", status: "running", detail: "preparing_sandbox" },
        { type: "todo", items: [{ content: "一", status: "completed" }] },
        { type: "status", status: "waiting", detail: null },
      ),
    );
    expect(timeline.items.filter((i) => i.kind === "todo")).toEqual([
      { kind: "todo", key: 3, items: [{ content: "一", status: "completed" }] },
    ]);
    expect(timeline.state).toEqual({ status: "waiting", detail: null });
  });

  it("回合没有正常结束、会话失败时，插一条说明：只有错误类别、状态码和参考号", () => {
    const { items } = buildTimeline(
      events(
        { type: "turn.ended", reason: "completed" },
        {
          type: "turn.ended",
          reason: "failed",
          error: { code: "model_unavailable", status: 502, ref: "k3x9" },
        },
        { type: "turn.ended", reason: "failed", error: { code: "context_too_long" } },
        {
          type: "status",
          status: "failed",
          detail: null,
          error: { code: "sandbox_unavailable", ref: "p2q7" },
        },
      ),
    );
    expect(items.map((i) => (i.kind === "notice" ? i.text : i.kind))).toEqual([
      "回合失败：模型服务暂时不可用（502 · 参考号 k3x9）",
      "回合失败：对话长度超出模型上限",
      "会话失败：沙箱暂时无法创建（参考号 p2q7）",
    ]);
  });

  it("换了模型时插一条说明", () => {
    const { items } = buildTimeline(
      events({ type: "model.changed", model: "deepseek-v4-pro", effort: "max" }),
    );
    expect(items).toEqual([{ kind: "model", key: 1, model: "deepseek-v4-pro", effort: "max" }]);
  });

  it("工具调用的摘要：优先文件路径、命令、搜索词", () => {
    expect(toolSummary({ file_path: "a.ts", limit: 10 })).toBe("a.ts");
    expect(toolSummary({ command: "pnpm test" })).toBe("pnpm test");
    expect(toolSummary({ other: 1, name: "x" })).toBe("x");
    expect(toolSummary(null)).toBe("");
  });
});
