import { useEffect, useRef, useState } from "react";

/**
 * Agent 回复的文字浮现：每段新来的字上浮加淡入，同一段里从左往右错开；行内代码连同背景小框整体上浮；
 * 代码块、表格里的字只淡入；动画结束后合并回普通文字，免得长回复的页面元素越来越多。
 * 一段就是一次收到的新文字（现在是一整条消息，接上流式增量以后是每次的增量），用它在原文里的位置表示。
 */
export interface LiveChunk {
  id: number;
  /** 在 Markdown 原文里的起止位置，[from, to)。 */
  from: number;
  to: number;
  born: number;
}

/** 相邻两个字错开的时间，最多这么多。 */
const CHAR_MS = 14;
/** 一段里从第一个字到最后一个字最多错开这么久，长的一段整体像一道波扫过去。 */
const WAVE_MS = 240;
/** 一段从出现到合并回普通文字：单个字的动画 0.7 秒（styles.css 的 chunk-rise），加上最长的错开时间，再留一点余量。 */
export const SETTLE_MS = 700 + WAVE_MS + 60;

/** 一段里第 index 个字（共 length 个）的动画延迟。 */
export function charDelay(index: number, length: number): number {
  return Math.round(index * Math.min(CHAR_MS, WAVE_MS / Math.max(1, length)));
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

type Range = [start: number, end: number];

const rangeOf = (node: HastNode): Range | undefined => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : [start, end];
};

/** 只淡入、不上浮的地方：代码是一列一列对齐的，每行都往上跳，整块会一直抖。 */
const FADE_ONLY = new Set(["pre", "table"]);

/**
 * rehype 插件：把落在 chunks 里的字包成带动画的片段。
 * 文字节点在原文里能原样找到时一个字对一个位置；找不到（转义、实体）时整段按开头的位置算。
 */
export function rehypeLiveChunks(options: { source: string; chunks: LiveChunk[] }) {
  const { source, chunks } = options;
  const chunkAt = (offset: number) => chunks.find((c) => offset >= c.from && offset < c.to);
  const delayAt = (offset: number, chunk: LiveChunk) =>
    charDelay(offset - chunk.from, chunk.to - chunk.from);
  /** 文字里第 index 个位置的字在原文里的位置。 */
  const locate = (value: string, own: Range) => {
    const found = source.indexOf(value, own[0]);
    const exact = found !== -1 && found + value.length <= own[1];
    return (index: number) => (exact ? found + index : own[0]);
  };

  const split = (node: HastNode, range: Range | undefined, fade: boolean): HastNode[] => {
    const value = node.value ?? "";
    const own = rangeOf(node) ?? range;
    if (!own || !value.trim()) return [node];
    const offsetAt = locate(value, own);
    const out: HastNode[] = [];
    let plain = "";
    let current: { chunk: LiveChunk; span: HastNode } | undefined;
    let i = 0;
    for (const char of value) {
      const offset = offsetAt(i);
      i += char.length;
      const chunk = chunkAt(offset);
      if (!chunk) {
        current = undefined;
        plain += char;
        continue;
      }
      if (plain) out.push({ type: "text", value: plain });
      plain = "";
      if (current?.chunk !== chunk) {
        current = {
          chunk,
          span: {
            type: "element",
            tagName: "span",
            properties: { className: fade ? ["chunk", "chunk-fade"] : ["chunk"] },
            children: [],
          },
        };
        out.push(current.span);
      }
      current.span.children?.push({
        type: "element",
        tagName: "span",
        properties: { style: `animation-delay:${delayAt(offset, chunk)}ms` },
        children: [{ type: "text", value: char }],
      });
    }
    if (plain) out.push({ type: "text", value: plain });
    return out;
  };

  /**
   * 行内代码从第一个字到收尾都在同一段新文字里，就是第一次出现，返回第一个字的延迟。
   * 前面的字是早先到的、已经显示过时不算：框一浮，那些字就又浮一次。
   */
  const boxDelay = (code: HastNode, range: Range | undefined) => {
    const own = rangeOf(code) ?? range;
    const text = code.children?.[0];
    if (!own || text?.type !== "text") return undefined;
    const first = locate(text.value ?? "", own)(0);
    const chunk = chunkAt(first);
    return chunk && own[1] <= chunk.to ? delayAt(first, chunk) : undefined;
  };

  const walk = (node: HastNode, range: Range | undefined, fade: boolean) => {
    if (!node.children) return;
    const inner = rangeOf(node) ?? range;
    const innerFade = fade || FADE_ONLY.has(node.tagName ?? "");
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return split(child, inner, innerFade);
      // pre、表格里 innerFade 已经为真：代码块的 code 和表格里的行内代码都照旧只淡入
      const box = child.tagName === "code" && !innerFade ? boxDelay(child, inner) : undefined;
      if (box !== undefined) {
        child.properties = {
          ...child.properties,
          className: ["chunk-box"],
          style: `animation-delay:${box}ms`,
        };
      }
      // 框在上浮时，里面的字只淡入，不然位移叠两次
      walk(child, inner, innerFade || box !== undefined);
      return [child];
    });
  };

  return (tree: HastNode) => {
    if (chunks.length > 0) walk(tree, undefined, false);
  };
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 跟踪一条回复里正在浮现的段落。live 为假（历史消息）或开了"减少动效"时什么都不做。
 * 新的一段在渲染时就算出来，第一次画出来就是动画的起点，不会先闪一下整段文字。
 */
export function useLiveChunks(text: string, live: boolean): LiveChunk[] {
  const state = useRef<{ seen: string; chunks: LiveChunk[]; next: number }>(undefined);
  state.current ??= { seen: live && !reducedMotion() ? "" : text, chunks: [], next: 0 };
  const s = state.current;
  if (text !== s.seen) {
    const grew = text.startsWith(s.seen) && text.length > s.seen.length;
    s.chunks =
      live && grew && !reducedMotion()
        ? [...s.chunks, { id: s.next++, from: s.seen.length, to: text.length, born: Date.now() }]
        : [];
    s.seen = text;
  }

  // 动画播完的段落合并回普通文字。
  const [, settle] = useState(0);
  const chunks = s.chunks;
  useEffect(() => {
    const first = chunks[0];
    if (!first) return;
    const timer = setTimeout(
      () => {
        const now = Date.now();
        s.chunks = s.chunks.filter((c) => now - c.born < SETTLE_MS);
        settle((n) => n + 1);
      },
      Math.max(0, first.born + SETTLE_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [chunks, s]);
  return chunks;
}
