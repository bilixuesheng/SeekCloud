/** 消息气泡出现的动画（styles.css 的 bubble-in）的时长。 */
export const BUBBLE_IN_MS = 420;

/**
 * 刚发的消息先显示一个气泡、播出现的动画；服务器确认后换成正式的那条，是另一个元素。
 * 换上来时动画还没播完，新元素就用负的 animation-delay 从当前进度接着播，免得气泡一下跳到终点、回弹被截断；
 * 已经播完就不再播（返回 undefined）。now 减发送时间就是已经播了多久。
 */
export function catchUpBubble(sentAt: string, now: number) {
  const elapsed = Math.max(0, now - Date.parse(sentAt));
  if (elapsed >= BUBBLE_IN_MS) return undefined;
  return { className: "bubble-in", style: { animationDelay: `${-elapsed}ms` } };
}
