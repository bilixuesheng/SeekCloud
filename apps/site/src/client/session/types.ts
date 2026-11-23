import type { SessionState, SessionStatus, SessionStatusDetail } from "@seekcloud/protocol";
import { type PlainKey, t } from "../i18n";

export type { Session } from "@seekcloud/protocol";

const STATUS: Record<SessionStatus, PlainKey> = {
  queued: "status.queued",
  running: "status.running",
  waiting: "status.waiting",
  dormant: "status.dormant",
  archived: "status.archived",
  failed: "status.failed",
};

const DETAIL: Record<NonNullable<SessionStatusDetail>, PlainKey> = {
  preparing_sandbox: "status.preparingSandbox",
  awaiting_input: "status.awaitingInput",
  done: "status.done",
};

/** 环境的名字：默认环境存的是空名字，按界面语言显示"默认环境"。 */
export const environmentLabel = (name: string): string => name || t("environment.default");

/** 会话状态的名字（排队中、运行中……）。 */
export const statusLabel = (status: SessionStatus): string => t(STATUS[status]);

export function statusText(state: SessionState): string {
  if (state.detail === "preparing_sandbox") return t(DETAIL.preparing_sandbox);
  if (state.status === "archived" || state.status === "failed") return statusLabel(state.status);
  // 等你输入、已完成：等待回复的附加说明，休眠以后保留（#139）
  if (state.detail === "awaiting_input") return t(DETAIL.awaiting_input);
  if (state.detail === "done" && state.status === "waiting") return t(DETAIL.done);
  return statusLabel(state.status);
}

/** 会话信息里的状态：状态加上附加说明，比如"休眠 · 等你输入"。 */
export function statusWithDetail(state: SessionState): string {
  const status = statusLabel(state.status);
  return state.detail
    ? t("status.withDetail", { status, detail: t(DETAIL[state.detail]) })
    : status;
}

/**
 * 侧栏会话右边显示哪个标记（规格 #138 的顺序，取第一个符合的）：失败 → 运行中或排队中 → 等你输入 →
 * 有新内容 → 不显示。等你输入的标记打开会话也不消失，直到管理员回了话；有新内容的蓝点打开就消掉。
 */
export function statusMark(
  state: SessionState,
  unread: boolean,
): "failed" | "running" | "awaiting" | "unread" | null {
  if (state.status === "failed") return "failed";
  if (state.status === "running" || state.status === "queued") return "running";
  if (state.detail === "awaiting_input" && state.status !== "archived") return "awaiting";
  if (unread) return "unread";
  return null;
}
