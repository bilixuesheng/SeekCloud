import { describe, expect, it } from "vitest";
import { judgeTurnEnd, looksLikeQuestion } from "./awaiting-input";

describe("回合结束后：等你输入还是已完成", () => {
  it.each([
    // 问句
    ["要把旧的接口一起删掉吗？", true],
    ["你希望用哪种方案：A 还是 B?", true],
    ["改好了。\n\n这个函数要不要也改成异步的？", true],
    ["接下来是先补测试，还是先发版呢。", true],
    ["需要我顺便把文档也更新吗", true],
    ["**要不要我现在就推送？**", true],
    ["- 你想保留旧的配置吗？", true],
    ["端口用 3000 还是 8080？🙂", true],
    ["Should I also update the README?", true],
    // 陈述句
    ["改好了，测试都通过了。", false],
    ["已经推送到 seekcloud/abc123。", false],
    ["完成！", false],
    ["Done.", false],
    // 空回复
    ["", false],
    ["   \n\n  ", false],
    // 最后一段是代码块或表格：往上找最后一段文字
    ['要用哪个版本？\n\n```json\n{ "a": 1 }\n```', true],
    ["改好了。\n\n```ts\nconst x = 1; // 对吗？\n```", false],
    ["结果如下：\n\n| 文件 | 行数 |\n|---|---|\n| a.ts | 3 |", false],
    ["要不要也看看 b.ts？\n\n| 文件 | 行数 |\n|---|---|\n| a.ts | 3 |", true],
    // 常见的客套问法：不算
    ["改好了，测试都过了。还有什么需要我做的吗？", false],
    ["已经修好了。如有其他问题，欢迎随时告诉我吗", false],
    ["都完成了。有任何问题吗？", false],
    ["Done. Anything else I can help with?", false],
    ["All set. Any other questions?", false],
  ])("%j → %s", (reply, question) => {
    expect(looksLikeQuestion(reply)).toBe(question);
  });

  it.each([
    [{ reason: "stopped" as const, reply: "要继续吗？" }, "done"],
    [{ reason: "failed" as const, reply: "" }, "awaiting_input"],
    [{ reason: "completed" as const, reply: "要继续吗？" }, "awaiting_input"],
    [{ reason: "completed" as const, reply: "做完了。" }, "done"],
    [{ reason: "completed" as const, reply: "" }, "done"],
  ])("%j → %s", async (outcome, detail) => {
    expect(await judgeTurnEnd(outcome)).toBe(detail);
  });
});
