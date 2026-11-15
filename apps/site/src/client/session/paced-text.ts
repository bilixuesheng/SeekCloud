import { useEffect, useLayoutEffect, useMemo, useState } from "react";

/**
 * Agent 回复在浏览器里按舒服的速度一个个显示出来（2026-11-15 用户的主意）：不管服务器那边是一整条到的，
 * 还是宿主机一段段推的增量（#31），显示的速度都由这里决定，看起来像在连贯地打字。
 * 平时每秒约 BASE_CPS 个字；没显示的积压多了就加快，保证 CATCH_UP_S 秒内追上，不会越落越远。
 * 不把 Markdown 的标记截在半截：加粗、行内代码、链接、英文单词、表格的一行、代码块的围栏行、
 * 行首的标题号和列表符号都整体出现，免得先露出一个"**"或"#"再变样子。
 */
const BASE_CPS = 40;
const CATCH_UP_S = 6;
const TICK_MS = 50;

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 每个位置能不能截断：blocked[i] 为真表示不能停在第 i 个字之前（0 和末尾总能停）。 */
export function cutMap(text: string): boolean[] {
  const blocked = new Array<boolean>(text.length + 1).fill(false);
  const block = (from: number, to: number) => {
    for (let i = from + 1; i < Math.min(to, text.length); i++) blocked[i] = true;
  };
  const each = (re: RegExp, fn: (start: number, end: number) => void) => {
    for (const m of text.matchAll(re)) fn(m.index, m.index + m[0].length);
  };
  // 行内的整体：加粗、行内代码、链接；英文单词和数字
  each(/\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\)/g, block);
  each(/[A-Za-z0-9_][A-Za-z0-9_.\-/]*/g, block);
  // 表格的一行、代码块的围栏行整行出现
  each(/^[ \t]*(\||```).*$/gm, block);
  // 行首的标题号、列表符号、引用号连同后面第一个字一起出现
  each(/^[ \t]*(#{1,6}[ \t]+|[-*+][ \t]+|\d+\.[ \t]+|>[ \t]?)/gm, (start, end) =>
    block(start, end + 1),
  );
  return blocked;
}

/** 从 from 往后显示到大约 want：不超过 want 的最后一个能停的位置；中间一个都没有时，往后找第一个。 */
export function nextCut(blocked: boolean[], from: number, want: number): number {
  const end = blocked.length - 1;
  const target = Math.min(Math.max(want, from + 1), end);
  for (let i = target; i > from; i--) if (!blocked[i]) return i;
  for (let i = target + 1; i <= end; i++) if (!blocked[i]) return i;
  return end;
}

/** 这一下显示多少个字：平时按 BASE_CPS，积压多了按 CATCH_UP_S 秒追上的速度。 */
export function step(backlog: number, ms = TICK_MS): number {
  return Math.max(1, Math.round((Math.max(BASE_CPS, backlog / CATCH_UP_S) * ms) / 1000));
}

/**
 * live 为假（打开会话时已有的历史）或开了"减少动效"时直接显示全文。
 * 文字变长（增量到了、完整的消息接过了增量）时接着往后显示；onGrow 在每次多显示了字以后调用（页面贴底跟随）。
 */
export function usePacedText(
  text: string,
  live: boolean,
  onGrow?: () => void,
): { shown: string; done: boolean } {
  const [count, setCount] = useState(() => (live && !reducedMotion() ? 0 : text.length));
  const blocked = useMemo(() => cutMap(text), [text]);
  const shownCount = Math.min(count, text.length);

  useEffect(() => {
    if (shownCount >= text.length) return;
    if (reducedMotion()) {
      setCount(text.length);
      return;
    }
    const timer = setTimeout(() => {
      setCount(nextCut(blocked, shownCount, shownCount + step(text.length - shownCount)));
    }, TICK_MS);
    return () => clearTimeout(timer);
  }, [shownCount, text, blocked]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 多显示了字就跟随
  useLayoutEffect(() => {
    if (shownCount > 0) onGrow?.();
  }, [shownCount]);

  return { shown: text.slice(0, shownCount), done: shownCount >= text.length };
}
