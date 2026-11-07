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
  return statusLabels[state.status];
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
