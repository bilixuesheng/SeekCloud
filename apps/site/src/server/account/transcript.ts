import type { SessionEvent, SessionRepo } from "@seekcloud/protocol";

/** 导出用的会话信息。 */
export interface ExportedSession {
  shortId: string;
  title: string;
  status: string;
  model: string;
  effort: string;
  createdAt: Date;
  repos: SessionRepo[];
}

/**
 * 导出文件里的 AI 生成标识（《人工智能生成合成内容标识办法》第四条：导出的文件里要有显式标识）。
 * Markdown 写在开头和每段 Agent 回复前；JSON 在开头说明，Agent 的消息带 aiGenerated: true。
 */
export const AI_NOTICE = "本文件中标注“AI 生成”的内容由人工智能（DeepSeek）生成，可能存在错误。";
const AGENT_HEADING = "## Agent（AI 生成）";

/** 导出时间统一写 UTC，免得看的人搞不清是哪个时区。 */
export function utcTime(at: Date | string): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** 代码块的围栏要比内容里最长的一串反引号还长，内容里有 ``` 也不会提前结束。 */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Markdown 里太长的工具输出截断；完整内容在同名的 JSON 里。 */
const OUTPUT_LIMIT = 4000;
function clip(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n…（其余 ${text.length - OUTPUT_LIMIT} 个字符已省略，完整内容见同名 .json 文件）`;
}

const errorNote = (error?: { code: string; ref?: string }) =>
  error ? `（错误类别 ${error.code}${error.ref ? `，参考号 ${error.ref}` : ""}）` : "";

const endReasons: Record<string, string> = {
  stopped: "回合已停止",
  failed: "回合失败",
};

/** 把一个会话写成人能读的 Markdown：你说的话、Agent 的回复、它调用的工具和结果。 */
export function sessionMarkdown(session: ExportedSession, events: SessionEvent[]): string {
  const lines: string[] = [`# ${session.title}`, "", `> ${AI_NOTICE}`, ""];
  for (const repo of session.repos) {
    lines.push(`- 仓库：${repo.fullName}（${repo.baseBranch} → ${repo.branch}）`);
  }
  lines.push(
    `- 创建时间：${utcTime(session.createdAt)}`,
    `- 模型：${session.model}（思考强度 ${session.effort}）`,
    `- 状态：${session.status}`,
    "",
    "---",
    "",
  );

  // 工具的结果跟在调用后面写，按 callId 找回调用的名字。
  const toolNames = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case "user.message":
        lines.push(`## 用户 · ${utcTime(event.at)}`, "", event.text, "");
        break;
      case "message":
        lines.push(AGENT_HEADING, "");
        if (event.thinking) {
          lines.push(...event.thinking.split("\n").map((line) => `> ${line}`), "");
        }
        lines.push(event.text, "");
        break;
      case "tool.call":
        toolNames.set(event.callId, event.name);
        lines.push(
          `**工具 ${event.name}**`,
          "",
          fenced(JSON.stringify(event.input, null, 2), "json"),
          "",
        );
        break;
      case "tool.result":
        lines.push(
          `${event.isError ? "出错" : "结果"}（${toolNames.get(event.callId) ?? "工具"}）：`,
          "",
          fenced(clip(event.output)),
          "",
        );
        break;
      case "todo":
        lines.push(
          "**待办**",
          "",
          ...event.items.map(
            (item) => `- [${item.status === "completed" ? "x" : " "}] ${item.content}`,
          ),
          "",
        );
        break;
      case "model.changed":
        lines.push(`> 切换至模型 ${event.model}（思考强度 ${event.effort}）`, "");
        break;
      case "turn.ended": {
        const reason = endReasons[event.reason];
        if (reason) lines.push(`> ${reason}${errorNote(event.error)}`, "");
        break;
      }
      case "status":
        if (event.status === "failed") lines.push(`> 会话失败${errorNote(event.error)}`, "");
        break;
      default:
        // 排队、撤回、回合开始这些不影响读对话，不写。
        break;
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** 导出的会话 JSON：开头说明 AI 生成标识，Agent 的消息带 aiGenerated: true。 */
export function sessionJson<T extends object>(session: T, events: SessionEvent[]) {
  return {
    aiNotice: AI_NOTICE,
    ...session,
    events: events.map((e) => (e.type === "message" ? { ...e, aiGenerated: true } : e)),
  };
}
