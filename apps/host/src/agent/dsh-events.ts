import type {
  AgentEvent,
  HostEvent,
  SafeError,
  TodoItem,
  TurnEndReason,
} from "@seekcloud/protocol";

/**
 * 把 dsh 的输出转成平台的事件（#25）。dsh 0.2.2-rc.3 的 SDK 实测的事件见 #25 的 2026-11-18 评论：
 *
 * - session.event 里存进会话日志的事件：turn/start、assistant/message（一步的完整回复：思考、正文、工具调用）、
 *   tool/call、tool/result、todo/write、turn/end；
 * - session.status：整个 Agent 在跑（running）还是闲下来了（idle）；
 * - live-output.js 写到第 4 个文件描述符的增量和 token 数。
 *
 * 平台的一个回合可能对应 dsh 的好几个回合：回合进行中插的话（inject_message），dsh 放进收件箱，
 * 当前回合结束后接着开一个新回合读它。所以平台的回合从 start_turn 以后 dsh 的第一个 turn/start 算起，
 * 到整个 Agent 闲下来（session.status 变成 idle）为止，结束的原因取 dsh 最后一个回合的。
 */
export class DshEventMapper {
  /** 平台现在这个回合；没有在跑的回合时为空。 */
  #turnId: string | undefined;
  #started = false;
  #lastReason: TurnEndReason = "completed";
  /** 这个回合里每次模型调用到现在的 token 数，加起来就是这个回合的总数。 */
  #callTokens = new Map<number, number>();
  #phase: "thinking" | "text" = "thinking";

  constructor(
    readonly sessionId: string,
    readonly emit: (event: HostEvent) => void,
  ) {}

  /** 平台开始一个回合（start_turn）：从 dsh 下一个 turn/start 起算到这个回合上。 */
  beginTurn(turnId: string): void {
    this.#turnId = turnId;
    this.#started = false;
    this.#lastReason = "completed";
    this.#callTokens.clear();
    this.#phase = "thinking";
  }

  get turnId(): string | undefined {
    return this.#turnId;
  }

  /** 平台的回合不管 dsh 说什么就此结束（停止、dsh 进程没了）。 */
  endTurn(reason: TurnEndReason, error?: SafeError): void {
    const turnId = this.#turnId;
    if (!turnId) return;
    if (!this.#started) this.#agent(turnId, { type: "turn.started" });
    this.#agent(
      turnId,
      error ? { type: "turn.ended", reason, error } : { type: "turn.ended", reason },
    );
    this.#turnId = undefined;
  }

  /** dsh 标准输出的一行（JSON-RPC 的通知；请求的回复在 JSON-RPC 客户端那里处理）。 */
  onNotification(method: string, params: unknown): void {
    if (method === "session.status") {
      const status = (params as { status?: string }).status;
      if (status === "idle" && this.#turnId && this.#started) this.endTurn(this.#lastReason);
      return;
    }
    if (method !== "session.event") return;
    const event = (params as { event?: { type?: string; data?: Record<string, unknown> } }).event;
    if (!event?.type) return;
    const turnId = this.#turnId;
    if (!turnId) return; // 不在平台的回合里（比如 dsh 自己整理上下文）
    const data = event.data ?? {};
    switch (event.type) {
      case "turn/start":
        if (!this.#started) {
          this.#started = true;
          this.#agent(turnId, { type: "turn.started" });
        }
        return;
      case "assistant/message": {
        const content = (data.message as { content?: unknown[] } | undefined)?.content ?? [];
        const text = joinBlocks(content, "text");
        const thinking = joinBlocks(content, "reasoning");
        if (text || thinking) {
          this.#agent(
            turnId,
            thinking ? { type: "message", text, thinking } : { type: "message", text },
          );
        }
        return;
      }
      case "tool/call": {
        const callId = String(data.callId ?? "");
        const name = String(data.name ?? "");
        if (!callId || !name) return;
        this.#agent(turnId, {
          type: "tool.call",
          callId,
          name,
          input: parseArguments(data.arguments),
        });
        return;
      }
      case "tool/result": {
        const message = (data.message ?? {}) as {
          toolCallId?: string;
          content?: unknown[];
          isError?: boolean;
        };
        if (!message.toolCallId) return;
        this.#agent(turnId, {
          type: "tool.result",
          callId: message.toolCallId,
          output: joinBlocks(message.content ?? [], "text"),
          isError: message.isError === true,
        });
        return;
      }
      case "todo/write": {
        const items = toTodos(data.todos);
        if (items) this.#agent(turnId, { type: "todo", items });
        return;
      }
      case "turn/end": {
        const kind = (data.reason as { kind?: string } | undefined)?.kind;
        this.#lastReason =
          kind === "completed"
            ? "completed"
            : kind === "cancelled" || kind === "interrupted"
              ? "stopped"
              : "failed";
        return;
      }
      default:
    }
  }

  /** live-output.js 写出来的一行。 */
  onLive(line: string): void {
    const turnId = this.#turnId;
    if (!turnId) return;
    let live: { kind?: string; text?: unknown; call?: unknown; tokens?: unknown };
    try {
      live = JSON.parse(line);
    } catch {
      return;
    }
    if (
      (live.kind === "text" || live.kind === "thinking") &&
      typeof live.text === "string" &&
      live.text
    ) {
      this.#phase = live.kind;
      this.emit({
        type: "delta",
        sessionId: this.sessionId,
        turnId,
        kind: live.kind,
        text: live.text,
      });
      return;
    }
    if (typeof live.call === "number" && typeof live.tokens === "number" && live.tokens >= 0) {
      this.#callTokens.set(live.call, live.tokens);
      let tokens = 0;
      for (const n of this.#callTokens.values()) tokens += n;
      this.emit({
        type: "progress",
        sessionId: this.sessionId,
        turnId,
        phase: this.#phase,
        tokens,
      });
    }
  }

  #agent(turnId: string, event: AgentEvent): void {
    this.emit({ type: "agent", sessionId: this.sessionId, turnId, event });
  }
}

/** 内容块里某一种的文字连起来（dsh 的块：text、reasoning、tool-call…）。 */
function joinBlocks(content: unknown[], type: string): string {
  return content
    .filter((b): b is { type: string; text: string } => {
      const block = b as { type?: unknown; text?: unknown };
      return block.type === type && typeof block.text === "string";
    })
    .map((b) => b.text)
    .join("");
}

/** 工具调用的参数：dsh 给的是 JSON 字符串；解析不了就原样给。 */
function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toTodos(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: TodoItem[] = [];
  for (const item of value) {
    const { content, status } = item as { content?: unknown; status?: unknown };
    if (typeof content !== "string") continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    items.push({ content, status });
  }
  return items;
}
