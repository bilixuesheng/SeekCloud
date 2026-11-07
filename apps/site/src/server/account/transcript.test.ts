import type { SessionEvent } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";
import { AI_NOTICE, sessionJson, sessionMarkdown } from "./transcript";

const session = {
  shortId: "abc12345",
  title: "修登录页",
  status: "waiting",
  model: "deepseek-flash",
  effort: "high",
  createdAt: new Date("2026-11-01T06:02:00Z"),
  repos: [
    {
      fullName: "me/app",
      baseBranch: "main",
      branch: "seekcloud/abc12345",
      access: "push" as const,
    },
  ],
};

let seq = 0;
const at = (body: Record<string, unknown>) =>
  ({ seq: ++seq, at: "2026-11-01T06:03:00.000Z", turn: 1, ...body }) as SessionEvent;

describe("导出的会话 Markdown", () => {
  it("开头是仓库、时间和模型；时间写 UTC", () => {
    const md = sessionMarkdown(session, []);
    expect(md).toContain("# 修登录页");
    expect(md).toContain("- 仓库：me/app（main → seekcloud/abc12345）");
    expect(md).toContain("- 创建时间：2026-11-01 06:02 UTC");
  });

  it("待办写成勾选框；回合失败带错误类别和参考号；排队、回合开始不写", () => {
    const md = sessionMarkdown(session, [
      at({ type: "user.message", text: "改一下" }),
      at({ type: "message.queued", id: "q1", text: "排队的话" }),
      at({ type: "turn.started" }),
      at({
        type: "todo",
        items: [
          { content: "找到表单", status: "completed" },
          { content: "补测试", status: "pending" },
        ],
      }),
      at({ type: "turn.ended", reason: "failed", error: { code: "model_unavailable", ref: "r9" } }),
    ]);
    expect(md).toContain("## 用户 · 2026-11-01 06:03 UTC\n\n改一下");
    expect(md).toContain("- [x] 找到表单\n- [ ] 补测试");
    expect(md).toContain("> 回合失败（错误类别 model_unavailable，参考号 r9）");
    expect(md).not.toContain("排队的话");
  });

  it("开头和每段 Agent 回复前注明 AI 生成", () => {
    const md = sessionMarkdown(session, [
      at({ type: "user.message", text: "改一下" }),
      at({ type: "message", text: "先看代码。" }),
      at({ type: "message", text: "改好了。" }),
    ]);
    expect(md.startsWith(`# 修登录页\n\n> ${AI_NOTICE}\n`)).toBe(true);
    expect(md.match(/^## Agent（AI 生成）\n\n/gm)).toHaveLength(2);
    expect(md).not.toMatch(/^## Agent\n/m);
  });

  it("JSON 开头说明标识，只有 Agent 的消息带 aiGenerated", () => {
    const events = [
      at({ type: "user.message", text: "改一下" }),
      at({ type: "message", text: "改好了。" }),
      at({ type: "tool.call", callId: "c", name: "Bash", input: {} }),
    ];
    const json = sessionJson(session, events);
    expect(Object.keys(json)[0]).toBe("aiNotice");
    expect(json.aiNotice).toBe(AI_NOTICE);
    expect(json.events.map((e) => "aiGenerated" in e && e.aiGenerated)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("太长的工具输出截断，说明完整内容在 JSON 里", () => {
    const md = sessionMarkdown(session, [
      at({ type: "tool.call", callId: "c", name: "Bash", input: { command: "cat big.log" } }),
      at({ type: "tool.result", callId: "c", output: "x".repeat(5000), isError: true }),
    ]);
    expect(md).toContain("出错（Bash）：");
    expect(md).toContain("其余 1000 个字符已省略，完整内容见同名 .json 文件");
  });
});
