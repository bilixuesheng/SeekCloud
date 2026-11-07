const pad = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 24 * 60 * 60 * 1000;

/**
 * 消息下面的时间，说人话：
 * 刚刚、5 分钟前、今天 14:02、昨天 14:02、11月1日 14:02，不是今年的写全年份。用本地时间。
 */
export function relativeTime(at: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000);
  // 本机时钟比服务器慢一点时也算"刚刚"，不显示负数。
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days === 0) return `今天 ${clock(at)}`;
  if (days === 1) return `昨天 ${clock(at)}`;
  if (at.getFullYear() === now.getFullYear()) {
    return `${at.getMonth() + 1}月${at.getDate()}日 ${clock(at)}`;
  }
  return `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日`;
}

/** 设置页上的时间：11月2日 20:02。 */
export function shortDateTime(at: Date): string {
  return `${at.getMonth() + 1}月${at.getDate()}日 ${clock(at)}`;
}

/** 指上去看到的完整时间。 */
export function fullTime(at: Date): string {
  return `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日 ${clock(at)}:${pad(at.getSeconds())}`;
}
