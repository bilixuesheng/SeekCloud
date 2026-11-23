import {
  type FileChange,
  MAX_PUSH_FOLLOW_UPS,
  type RepoOutcome,
  type SessionEvent,
  type SessionState,
  type ThinkingEffort,
  type TodoItem,
} from "@seekcloud/protocol";
import { type PlainKey, t } from "../i18n";
import { joinClauses, joinNames } from "../i18n/format";
import { errorText } from "./errors";

export interface ToolCall {
  key: number;
  name: string;
  input: unknown;
  result?: { output: string; isError: boolean };
}

/** 一个回合改了的文件（改动卡片，#27）：只有改了文件的仓库。 */
export interface TurnChanges {
  repos: Array<{
    fullName: string;
    files: FileChange[];
    /** 没列出来的文件个数。 */
    omittedFiles: number;
    push: RepoOutcome["push"];
  }>;
}

export type TimelineItem =
  /**
   * at：服务器收到的时间，显示在消息下面。
   * delivered：已经交给 Agent（所在的回合开始了，或者是立即发送的插话）。排队、准备沙箱时还没有。
   */
  | { kind: "user"; key: number; text: string; at: string; delivered: boolean }
  /**
   * turnEnd：这是一个回合里最后一条回复，回合已经结束。reply 是这个回合全部回复的原文（复制用），
   * at 是回合结束的时间。
   */
  | {
      kind: "assistant";
      key: number;
      text: string;
      thinking?: string;
      turnEnd?: { reply: string; at: string; changes?: TurnChanges };
    }
  /** 回合里没有回复、但改了文件：改动卡片单独放。 */
  | { kind: "changes"; key: number; changes: TurnChanges }
  /** 连续的工具调用合成一组，界面上先显示一行摘要。 */
  | { kind: "tools"; key: number; calls: ToolCall[] }
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
  /**
   * 正在运行的工具调用（"运行 pnpm test"），对话底部那一行这时写它、不显示 token 数（照 Claude）。
   * 没有工具在跑（模型在思考、写回复）时没有，那一行写"深度求索中"和这个回合的 token 数。
   */
  activity?: string;
  /**
   * 这个回合的计划（待办清单的最新一份）。照 Claude：回合进行中始终放在对话最下面，回合结束或停止以后就没有了。
   * stale：计划最后一次更新以后管理员又发了消息，标题写"你上一条消息之前的计划"。
   */
  plan?: { items: TodoItem[]; stale: boolean };
}

/** 回合停止、失败时的提示；有报错时接在后面。 */
function endNotice(reason: "stopped" | "failed", error: string | undefined) {
  if (reason === "stopped") {
    return {
      tone: "info" as const,
      text: error ? t("chat.turnStoppedWith", { error }) : t("chat.turnStopped"),
    };
  }
  return {
    tone: "error" as const,
    text: error ? t("chat.turnFailedWith", { error }) : t("chat.turnFailed"),
  };
}

/**
 * 把会话事件整理成界面上的一条条内容。提示的文字按当前的界面语言写：换了语言要重新整理一遍
 * （SessionPage 的 useMemo 带上了语言）。
 */
export function buildTimeline(events: SessionEvent[]): Timeline {
  const items: TimelineItem[] = [];
  const calls = new Map<string, ToolCall>();
  let state: SessionState | undefined;
  let since: string | undefined;
  let queued: Timeline["queued"] = [];
  // 还没交给 Agent 的用户消息：回合开始时一起标成已交付。
  let undelivered: Array<Extract<TimelineItem, { kind: "user" }>> = [];
  // 当前回合里 Agent 的回复，回合结束时在最后一条下面放"复制"。
  let replies: Array<Extract<TimelineItem, { kind: "assistant" }>> = [];
  // 还没出结果的工具调用：callId → 一句话的描述
  let running = new Map<string, string>();
  let plan: Timeline["plan"];
  // 改动卡片：workspace 在 turn.ended 前面到，先记下；停止的回合晚到，挂回那个回合
  const pendingChanges = new Map<number, TurnChanges>();
  const endedTurns = new Map<number, Extract<TimelineItem, { kind: "assistant" }> | undefined>();

  for (const event of events) {
    switch (event.type) {
      case "user.message": {
        if (event.followUp) {
          // 平台自动开的跟进回合：不是管理员说的话，写一行提示
          items.push({
            kind: "notice",
            key: event.seq,
            tone: "info",
            text: t("chat.pushFollowUp"),
          });
          break;
        }
        // 由排队的消息合成的回合开头：排队的那几条换成这一条。
        if (event.queued) queued = queued.filter((q) => !event.queued?.includes(q.id));
        const item = {
          kind: "user" as const,
          key: event.seq,
          text: event.text,
          at: event.at,
          // 插话是在回合进行中直接送给 Agent 的。
          delivered: event.injected === true,
        };
        if (!item.delivered) undelivered.push(item);
        items.push(item);
        if (plan) plan = { ...plan, stale: true };
        break;
      }
      case "turn.started":
        for (const item of undelivered) item.delivered = true;
        undelivered = [];
        replies = [];
        running = new Map();
        break;
      case "message.queued":
        queued.push({ id: event.id, text: event.text });
        break;
      case "message.withdrawn":
        queued = queued.filter((q) => q.id !== event.id);
        break;
      case "message": {
        const item = {
          kind: "assistant" as const,
          key: event.seq,
          text: event.text,
          thinking: event.thinking,
        };
        replies.push(item);
        items.push(item);
        break;
      }
      case "tool.call": {
        const call: ToolCall = { key: event.seq, name: event.name, input: event.input };
        calls.set(event.callId, call);
        const last = items.at(-1);
        if (last?.kind === "tools") last.calls.push(call);
        else items.push({ kind: "tools", key: event.seq, calls: [call] });
        running.set(
          event.callId,
          t("tool.activity", {
            label: toolLabel(event.name),
            detail: firstLine(toolSummary(event.input)) ?? "",
          }).trim(),
        );
        break;
      }
      case "tool.result": {
        const call = calls.get(event.callId);
        if (call) call.result = { output: event.output, isError: event.isError };
        running.delete(event.callId);
        break;
      }
      case "todo":
        plan = { items: event.items, stale: false };
        break;
      case "workspace": {
        const changes = turnChanges(event.repos);
        if (!changes || event.turn === null) break;
        if (!endedTurns.has(event.turn)) {
          pendingChanges.set(event.turn, changes);
          break;
        }
        const reply = endedTurns.get(event.turn);
        if (reply?.turnEnd) reply.turnEnd.changes = changes;
        else items.push({ kind: "changes", key: event.seq, changes });
        break;
      }
      case "push.gave_up":
        items.push({
          kind: "notice",
          key: event.seq,
          tone: "error",
          text: t("chat.pushGaveUp", {
            count: MAX_PUSH_FOLLOW_UPS,
            repos: joinNames(event.repos),
          }),
        });
        break;
      case "model.changed":
        items.push({ kind: "model", key: event.seq, model: event.model, effort: event.effort });
        break;
      case "turn.ended": {
        const last = replies.at(-1);
        const changes = event.turn === null ? undefined : pendingChanges.get(event.turn);
        if (last) {
          const reply = replies
            .map((r) => r.text)
            .filter((text) => text.trim())
            .join("\n\n");
          if (reply) last.turnEnd = { reply, at: event.at, ...(changes && { changes }) };
        }
        if (changes && !last?.turnEnd) items.push({ kind: "changes", key: event.seq, changes });
        if (event.turn !== null) endedTurns.set(event.turn, last?.turnEnd ? last : undefined);
        replies = [];
        running = new Map();
        plan = undefined;
        if (event.reason !== "completed") {
          const notice = endNotice(event.reason, event.error && errorText(event.error));
          items.push({ kind: "notice", key: event.seq, ...notice });
        }
        break;
      }
      case "status":
        if (event.status !== state?.status) since = event.at;
        state = { status: event.status, detail: event.detail };
        if (event.status === "failed") {
          const text = event.error
            ? t("chat.sessionFailedWith", { error: errorText(event.error) })
            : t("chat.sessionFailed");
          items.push({ kind: "notice", key: event.seq, tone: "error", text });
        }
        break;
    }
  }
  return { items, state, since, queued, activity: [...running.values()].at(-1), plan };
}

/** 改动卡片的内容：只留改了文件的仓库；都没改就没有卡片。 */
function turnChanges(repos: RepoOutcome[]): TurnChanges | undefined {
  const changed = repos
    .filter((r) => r.files.length > 0 || (r.omittedFiles ?? 0) > 0)
    .map((r) => ({
      fullName: r.fullName,
      files: r.files,
      omittedFiles: r.omittedFiles ?? 0,
      push: r.push,
    }));
  return changed.length > 0 ? { repos: changed } : undefined;
}

/** 第一个不是空白的行（多行的命令只写第一行）。 */
function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

/** 认得的工具：名字（"读取"）和正在做时的说法（"正在读取"，英文要换成进行时，不能拼）。 */
const TOOLS: Record<string, { label: PlainKey; active: PlainKey }> = {
  Read: { label: "tool.read", active: "tool.readActive" },
  Write: { label: "tool.write", active: "tool.writeActive" },
  Edit: { label: "tool.edit", active: "tool.editActive" },
  MultiEdit: { label: "tool.edit", active: "tool.editActive" },
  Bash: { label: "tool.bash", active: "tool.bashActive" },
  Grep: { label: "tool.grep", active: "tool.grepActive" },
  Glob: { label: "tool.glob", active: "tool.globActive" },
  LS: { label: "tool.ls", active: "tool.lsActive" },
  WebFetch: { label: "tool.webFetch", active: "tool.webFetchActive" },
  WebSearch: { label: "tool.webSearch", active: "tool.webSearchActive" },
  TodoWrite: { label: "tool.todo", active: "tool.todoActive" },
  Task: { label: "tool.task", active: "tool.taskActive" },
};

/** 工具的名字（"读取"）；不认得的工具写它自己的名字。 */
export const toolLabel = (name: string): string => {
  const tool = TOOLS[name];
  return tool ? t(tool.label) : name;
};

/** 工具正在做时的说法（"正在读取"、"Reading"）。 */
export const toolActive = (name: string): string => {
  const tool = TOOLS[name];
  return tool ? t(tool.active) : t("tool.otherActive", { name });
};

// 一组工具调用的摘要怎么说：按工具归类计数，每一类是一个整句模板（英文分单复数）。
const kinds: Array<{ tools: string[]; say: (count: number) => string }> = [
  { tools: ["Read"], say: (count) => t("tools.read", { count }) },
  { tools: ["Edit", "MultiEdit", "Write"], say: (count) => t("tools.edit", { count }) },
  { tools: ["Bash"], say: (count) => t("tools.bash", { count }) },
  {
    tools: ["Grep", "Glob", "LS", "WebSearch"],
    say: (count) => t("tools.search", { count }),
  },
  { tools: ["WebFetch"], say: (count) => t("tools.fetch", { count }) },
];

/** "运行了 2 条命令，修改了 1 个文件"；英文 "Ran 2 commands and edited 1 file"。 */
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
  if (other > 0) parts.push(t("tools.other", { count: other }));
  return joinClauses(parts);
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
