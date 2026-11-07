import type { Timeline } from "./timeline";

/** 滚动区域里用到的三个量，和 HTMLElement 上的同名属性一样。 */
export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** 离底部这么近就算在底部。 */
const NEAR_BOTTOM = 24;

/**
 * 会话页的滚动跟随（2026-11-07 用户在预览里定的）：
 * - 只有来了新内容、并且在跟随时，才滚到最底下；展开收起卡片、时间刷新不算新内容，不动滚动位置；
 * - 手指往上拖或滚轮往上，马上停止跟随，不等 scroll 事件，免得和流式输出抢；
 * - 自己回到底部（或点了回到底部的按钮）才恢复。
 */
export class ScrollFollower {
  #following = true;
  #lastTop = 0;

  constructor(
    private readonly box: ScrollBox,
    /** 跟随状态变了：away 为 true 时显示回到底部的按钮。 */
    private readonly onAwayChange: (away: boolean) => void = () => {},
  ) {}

  get following(): boolean {
    return this.#following;
  }

  /** 手指拖动了 dy 像素（往下拖是正数，内容往上走，也就是往回看）。 */
  dragged(dy: number): void {
    if (dy > 0) this.#set(false);
  }

  /** 滚轮滚了 deltaY（往上是负数）。 */
  wheeled(deltaY: number): void {
    if (deltaY < 0) this.#set(false);
  }

  /** scroll 事件：往上滚了就不跟随；到了底部就恢复。 */
  scrolled(): void {
    const top = this.box.scrollTop;
    if (top < this.#lastTop - 1) this.#set(false);
    if (this.#gap() < NEAR_BOTTOM) this.#set(true);
    this.#lastTop = top;
  }

  /** 来了新内容（新消息、流式输出、Agent 开始或停下）。 */
  contentAdded(): void {
    if (this.#following) this.#stick();
  }

  /** 回到最底下，并恢复跟随：打开会话、发消息、点回到底部的按钮。 */
  toBottom(): void {
    this.#set(true);
    this.#stick();
  }

  #stick(): void {
    this.box.scrollTop = this.box.scrollHeight;
    this.#lastTop = this.box.scrollTop;
  }

  #gap(): number {
    return this.box.scrollHeight - this.box.scrollTop - this.box.clientHeight;
  }

  #set(following: boolean): void {
    if (following === this.#following) return;
    this.#following = following;
    this.onAwayChange(!following);
  }
}

/**
 * 时间线上"有没有新内容"的指纹：条数、最后一条长了多少、排队的消息、刚发出去的消息和会话状态。
 * 展开卡片、时间刷新都不改它，所以不会把页面拉到底下。
 */
export function contentKey(timeline: Timeline, extra: string): string {
  const last = timeline.items.at(-1);
  let size = 0;
  if (last?.kind === "assistant") size = last.text.length + (last.thinking?.length ?? 0);
  else if (last?.kind === "tools")
    size = last.calls.length * 2 + last.calls.filter((c) => c.result).length;
  else if (last?.kind === "todo") size = last.items.length;
  return [
    timeline.items.length,
    size,
    timeline.queued.length,
    timeline.state?.status,
    timeline.state?.detail,
    extra,
  ].join(":");
}
