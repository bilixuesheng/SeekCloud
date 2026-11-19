import type { HostEvent } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";
import { DshAgent } from "./dsh-agent";

describe("Agent 适配接口（连不上运行器）", () => {
  it("运行器没了：回合不一直挂着，到时间以内部错误失败，原始报错只进日志", async () => {
    const events: HostEvent[] = [];
    const logs: string[] = [];
    const agent = new DshAgent({
      sessionId: "s1",
      // 沙箱里的运行器没在跑：每次连都失败
      bridge: () => [process.execPath, "-e", "process.stderr.write('连不上'); process.exit(1)"],
      launch: () => ({ args: ["dsh"], cwd: "/", env: {}, workingDirectory: "/workspace" }),
      emit: (e) => events.push(e),
      log: (m) => logs.push(m),
      connectTimeoutMs: 300,
    });
    try {
      await agent.startTurn({
        turnId: "t1",
        text: "hi",
        model: "deepseek-flash",
        effort: "high",
        firstTurn: true,
      });
      const ended = events.flatMap((e) =>
        e.type === "agent" && e.event.type === "turn.ended" ? [e.event] : [],
      );
      expect(ended).toEqual([
        {
          type: "turn.ended",
          reason: "failed",
          error: { code: "internal", ref: expect.any(String) },
        },
      ]);
      expect(logs.some((l) => l.includes("连不上沙箱里的运行器"))).toBe(true);
    } finally {
      agent.close();
    }
  });
});
