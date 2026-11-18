import type { HostEvent } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";
import { DshEventMapper } from "./dsh-events";

/** dsh 的一条 session.event（形状照 0.2.2-rc.3 实测的）。 */
const ev = (type: string, data: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  event: { type, seq: 0, time: 0, data },
});

describe("dsh 的事件转成平台的事件", () => {
  const setup = () => {
    const out: HostEvent[] = [];
    const mapper = new DshEventMapper("s1", (e) => out.push(e));
    const agent = () => out.flatMap((e) => (e.type === "agent" ? [e.event] : []));
    return { mapper, out, agent };
  };

  it("一个有工具调用的回合：开始 → 消息 → 工具调用和结果 → 待办 → 结束", () => {
    const { mapper, agent, out } = setup();
    mapper.beginTurn("t1");
    mapper.onNotification("session.status", { sessionId: "s1", status: "running" });
    mapper.onNotification("session.event", ev("turn/start", { turn: 1 }));
    mapper.onNotification(
      "session.event",
      ev("assistant/message", {
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "先看看" },
            { type: "tool-call", id: "toolu_1", name: "bash", arguments: "{}" },
          ],
        },
      }),
    );
    mapper.onNotification(
      "session.event",
      ev("tool/call", { callId: "toolu_1", name: "bash", arguments: '{"command":"echo 你好"}' }),
    );
    mapper.onNotification(
      "session.event",
      ev("tool/result", {
        message: {
          toolCallId: "toolu_1",
          content: [{ type: "text", text: "你好\n" }],
          isError: false,
        },
      }),
    );
    mapper.onNotification(
      "session.event",
      ev("todo/write", {
        todos: [
          { content: "写代码", status: "in_progress" },
          { content: "跑测试", status: "pending" },
          { content: "坏的", status: "unknown" },
        ],
      }),
    );
    mapper.onNotification(
      "session.event",
      ev("assistant/message", { message: { content: [{ type: "text", text: "都做完了" }] } }),
    );
    mapper.onNotification(
      "session.event",
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
    );
    mapper.onNotification("session.status", { sessionId: "s1", status: "idle" });

    expect(agent()).toEqual([
      { type: "turn.started" },
      { type: "message", text: "", thinking: "先看看" },
      { type: "tool.call", callId: "toolu_1", name: "bash", input: { command: "echo 你好" } },
      { type: "tool.result", callId: "toolu_1", output: "你好\n", isError: false },
      {
        type: "todo",
        items: [
          { content: "写代码", status: "in_progress" },
          { content: "跑测试", status: "pending" },
        ],
      },
      { type: "message", text: "都做完了" },
      { type: "turn.ended", reason: "completed" },
    ]);
    expect(out.every((e) => e.sessionId === "s1" && "turnId" in e && e.turnId === "t1")).toBe(true);
    expect(mapper.turnId).toBeUndefined();
  });

  it("回合进行中插了话：dsh 接着开第二个回合，平台的回合到整个 Agent 闲下来才结束", () => {
    const { mapper, agent } = setup();
    mapper.beginTurn("t1");
    mapper.onNotification("session.event", ev("turn/start", { turn: 1 }));
    mapper.onNotification(
      "session.event",
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
    );
    mapper.onNotification("session.event", ev("turn/start", { turn: 2 }));
    mapper.onNotification("session.event", ev("turn/end", { turn: 2, reason: { kind: "error" } }));
    expect(agent()).toEqual([{ type: "turn.started" }]);
    mapper.onNotification("session.status", { status: "idle" });
    expect(agent()).toEqual([{ type: "turn.started" }, { type: "turn.ended", reason: "failed" }]);
  });

  it("增量和 token 数：一个回合里几次模型调用的 token 加起来；阶段跟着最近的增量", () => {
    const { mapper, out } = setup();
    mapper.beginTurn("t1");
    mapper.onLive(JSON.stringify({ kind: "thinking", text: "想" }));
    mapper.onLive(JSON.stringify({ call: 1, tokens: 3 }));
    mapper.onLive(JSON.stringify({ call: 1, tokens: 5 }));
    mapper.onLive(JSON.stringify({ kind: "text", text: "答" }));
    mapper.onLive(JSON.stringify({ call: 2, tokens: 4 }));
    mapper.onLive("不是 JSON");
    expect(out).toEqual([
      { type: "delta", sessionId: "s1", turnId: "t1", kind: "thinking", text: "想" },
      { type: "progress", sessionId: "s1", turnId: "t1", phase: "thinking", tokens: 3 },
      { type: "progress", sessionId: "s1", turnId: "t1", phase: "thinking", tokens: 5 },
      { type: "delta", sessionId: "s1", turnId: "t1", kind: "text", text: "答" },
      { type: "progress", sessionId: "s1", turnId: "t1", phase: "text", tokens: 9 },
    ]);
    // 新回合从 0 数起
    mapper.endTurn("completed");
    mapper.beginTurn("t2");
    mapper.onLive(JSON.stringify({ call: 3, tokens: 2 }));
    expect(out.at(-1)).toMatchObject({ turnId: "t2", tokens: 2 });
  });

  it("不在平台的回合里时什么都不转；停止或者 dsh 没了时由平台结束回合（没开始也补一个开始）", () => {
    const { mapper, agent, out } = setup();
    mapper.onNotification("session.event", ev("turn/start", { turn: 1 }));
    mapper.onLive(JSON.stringify({ kind: "text", text: "x" }));
    expect(out).toEqual([]);
    mapper.beginTurn("t1");
    mapper.endTurn("failed", { code: "internal", ref: "abcd1234" });
    expect(agent()).toEqual([
      { type: "turn.started" },
      { type: "turn.ended", reason: "failed", error: { code: "internal", ref: "abcd1234" } },
    ]);
    mapper.endTurn("stopped");
    expect(agent()).toHaveLength(2);
  });

  it("工具参数不是合法 JSON 时原样给；结束原因 cancelled 算停止", () => {
    const { mapper, agent } = setup();
    mapper.beginTurn("t1");
    mapper.onNotification("session.event", ev("turn/start"));
    mapper.onNotification(
      "session.event",
      ev("tool/call", { callId: "c", name: "bash", arguments: "{坏" }),
    );
    mapper.onNotification("session.event", ev("turn/end", { reason: { kind: "cancelled" } }));
    mapper.onNotification("session.status", { status: "idle" });
    expect(agent()).toContainEqual({ type: "tool.call", callId: "c", name: "bash", input: "{坏" });
    expect(agent().at(-1)).toEqual({ type: "turn.ended", reason: "stopped" });
  });
});
