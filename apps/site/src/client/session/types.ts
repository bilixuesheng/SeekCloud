import type { SessionState, SessionStatus } from "@seekcloud/protocol";

export type { Session } from "@seekcloud/protocol";

export const statusLabels: Record<SessionStatus, string> = {
  queued: "排队中",
  running: "运行中",
  waiting: "等待回复",
  dormant: "休眠",
  archived: "已归档",
  failed: "失败",
};

export function statusText(state: SessionState): string {
  if (state.detail === "preparing_sandbox") return "正在准备沙箱";
  if (state.status === "archived" || state.status === "failed") return statusLabels[state.status];
  // 等你输入、已完成：等待回复的附加说明，休眠以后保留（#139）
  if (state.detail === "awaiting_input") return "等你输入";
  if (state.detail === "done" && state.status === "waiting") return "已完成";
  return statusLabels[state.status];
}

/** 会话信息里的状态：状态加上附加说明，比如"休眠 · 等你输入"。 */
export function statusWithDetail(state: SessionState): string {
  const detail =
    state.detail === "preparing_sandbox"
      ? "正在准备沙箱"
      : state.detail === "awaiting_input"
        ? "等你输入"
        : state.detail === "done"
          ? "已完成"
          : undefined;
  return detail ? `${statusLabels[state.status]} · ${detail}` : statusLabels[state.status];
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

const beijing = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
});

/** 会话列表里的时间："刚刚"、"5 分钟前"……更早的显示北京时间的日期。 */
export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))} 天前`;
  return beijing.format(new Date(iso));
}
