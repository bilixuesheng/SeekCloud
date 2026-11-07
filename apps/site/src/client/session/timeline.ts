import type { SessionEvent, SessionState, ThinkingEffort, TodoItem } from "@seekcloud/protocol";
import { errorText } from "./errors";

export interface ToolCall {
  key: number;
  name: string;
  input: unknown;
  result?: { output: string; isError: boolean };
}

export type TimelineItem =
  /** at：服务器收到的时间，显示在消息下面。 */
  | { kind: "user"; key: number; text: string; at: string }
  | { kind: "assistant"; key: number; text: string; thinking?: string }
  /** 连续的工具调用合成一组，界面上先显示一行摘要。 */
  | { kind: "tools"; key: number; calls: ToolCall[] }
  /** 待办清单只显示最新的一份，放在它最后一次更新的位置。 */
  | { kind: "todo"; key: number; items: TodoItem[] }
  | { kind: "notice"; key: number; tone: "info" | "error"; text: string }
  | { kind: "model"; key: number; model: string; effort: ThinkingEffort };

export interface Timeline {
  items: TimelineItem[];
  /** 最新的状态；还没收到状态事件时为 undefined。 */
  state?: SessionState;
  /** 进入最新状态的时间，用来显示"已经运行了多久"。 */
  since?: string;
  /** Agent 工作时发的、还在排队的消息，按发的顺序。显示在对话末尾，可以撤回或立即发送。 */
  queued: Array<{ id: string; text: string }>;
}

const endNotices = {
  stopped: { tone: "info", text: "回合已停止" },
  failed: { tone: "error", text: "回合失败" },
} as const;

/** 把会话事件整理成界面上的一条条内容。 */
export function buildTimeline(events: SessionEvent[]): Timeline {
  let items: TimelineItem[] = [];
  const calls = new Map<string, ToolCall>();
  let state: SessionState | undefined;
  let since: string | undefined;
  let queued: Timeline["queued"] = [];

  for (const event of events) {
    switch (event.type) {
      case "user.message":
        // 由排队的消息合成的回合开头：排队的那几条换成这一条。
        if (event.queued) queued = queued.filter((q) => !event.queued?.includes(q.id));
        items.push({ kind: "user", key: event.seq, text: event.text, at: event.at });
        break;
      case "message.queued":
        queued.push({ id: event.id, text: event.text });
        break;
      case "message.withdrawn":
        queued = queued.filter((q) => q.id !== event.id);
        break;
      case "message":
        items.push({
          kind: "assistant",
          key: event.seq,
          text: event.text,
          thinking: event.thinking,
        });
        break;
      case "tool.call": {
        const call: ToolCall = { key: event.seq, name: event.name, input: event.input };
        calls.set(event.callId, call);
        const last = items.at(-1);
        if (last?.kind === "tools") last.calls.push(call);
        else items.push({ kind: "tools", key: event.seq, calls: [call] });
        break;
      }
      case "tool.result": {
        const call = calls.get(event.callId);
        if (call) call.result = { output: event.output, isError: event.isError };
        break;
      }
      case "todo":
        items = items.filter((item) => item.kind !== "todo");
        items.push({ kind: "todo", key: event.seq, items: event.items });
        break;
      case "model.changed":
        items.push({ kind: "model", key: event.seq, model: event.model, effort: event.effort });
        break;
      case "turn.ended":
        if (event.reason !== "completed") {
          const notice = endNotices[event.reason];
          const text = event.error ? `${notice.text}：${errorText(event.error)}` : notice.text;
          items.push({ kind: "notice", key: event.seq, tone: notice.tone, text });
        }
        break;
      case "status":
        if (event.status !== state?.status) since = event.at;
        state = { status: event.status, detail: event.detail };
        if (event.status === "failed") {
          const text = event.error ? `会话失败：${errorText(event.error)}` : "会话失败";
          items.push({ kind: "notice", key: event.seq, tone: "error", text });
        }
        break;
    }
  }
  return { items, state, since, queued };
}

const toolLabels: Record<string, string> = {
  Read: "读取",
  Write: "写入",
  Edit: "编辑",
  MultiEdit: "编辑",
  Bash: "运行",
  Grep: "搜索",
  Glob: "查找文件",
  LS: "列出目录",
  WebFetch: "抓取网页",
  WebSearch: "搜索网页",
  TodoWrite: "更新待办",
  Task: "子 Agent",
};

export const toolLabel = (name: string) => toolLabels[name] ?? name;

// 一组工具调用的摘要怎么说：按工具归类计数。
const kinds: Array<{ tools: string[]; say: (n: number) => string }> = [
  { tools: ["Read"], say: (n) => `读取了 ${n} 个文件` },
  { tools: ["Edit", "MultiEdit", "Write"], say: (n) => `修改了 ${n} 个文件` },
  { tools: ["Bash"], say: (n) => `运行了 ${n} 条命令` },
  { tools: ["Grep", "Glob", "LS", "WebSearch"], say: (n) => `搜索了 ${n} 次` },
  { tools: ["WebFetch"], say: (n) => `抓取了 ${n} 个网页` },
];

/** "运行了 2 条命令，改了 1 个文件"。 */
export function summarizeTools(calls: ToolCall[]): string {
  const parts: string[] = [];
  let other = 0;
  const counts = new Map<number, number>();
  for (const call of calls) {
    const index = kinds.findIndex((k) => k.tools.includes(call.name));
    if (index === -1) other++;
    else counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  for (const [index, n] of [...counts].sort((a, b) => a[0] - b[0])) {
    parts.push((kinds[index] as (typeof kinds)[number]).say(n));
  }
  if (other > 0) parts.push(`使用了 ${other} 个其他工具`);
  return parts.join("，");
}

/** 工具调用的一句话摘要：文件路径、命令、搜索词之类。 */
export function toolSummary(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "url", "query", "description"]) {
    if (typeof record[key] === "string") return record[key];
  }
  const first = Object.values(record).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}
