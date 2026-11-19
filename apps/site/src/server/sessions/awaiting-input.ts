import type { TurnEndReason } from "@seekcloud/protocol";

/**
 * 回合结束以后，"等待回复"的会话带哪个附加说明（#139，规格 #138）：等你输入（Agent 在等管理员回答）
 * 还是已完成（做完了，在待命）。
 *
 * - 被管理员停止：已完成；
 * - 回合失败：等你输入（要管理员决定怎么办）；
 * - 正常结束：最后一条回复的最后一段是不是问句。规则版先顶着，#140 换成一次便宜的模型调用，
 *   所以接口是异步的，换的时候只改这里。
 *
 * 卡片（选择题 #42、批准 #41、计划待批准）和用量上限暂停现在还没有对应的事件：做那几张时，在各自的地方
 * 直接设成"等你输入"，不经过这里的规则（它们一定是在等管理员）。
 */
export type TurnEndDetail = "awaiting_input" | "done";

export async function judgeTurnEnd(outcome: {
  reason: TurnEndReason;
  /** 这个回合最后一条 Agent 回复；没说话时是空的。 */
  reply: string;
}): Promise<TurnEndDetail> {
  if (outcome.reason === "stopped") return "done";
  if (outcome.reason === "failed") return "awaiting_input";
  return looksLikeQuestion(outcome.reply) ? "awaiting_input" : "done";
}

/** 结尾常见的客套问法：问了也不是真在等回答（规则版的已知误报，先排除最常见的几种）。 */
const POLITE_CLOSINGS = [
  /还有(什么|别的|其他|其它)[^。？?]{0,10}(吗|么)$/,
  /(有|如有)(任何)?(其他|别的|其它)?(问题|疑问|需要)[^。？?]{0,8}(吗|么)$/,
  /^(需要|要)(我)?(帮你|帮忙)?(做|改)?(点|些)?(别的|其他|其它)(什么|的)?(吗|么)$/,
  /anything else\b.*$/i,
  /(any|other) (other )?questions\b.*$/i,
];

/**
 * 最后一条回复的最后一段文字是不是问句：跳过代码块、表格、空行；去掉结尾的 Markdown 标记、表情和
 * 除问号以外的标点；以问号结尾，或者以"吗""呢""么"结尾（后面原来跟的是句号、感叹号这类）就算问句。
 */
export function looksLikeQuestion(reply: string): boolean {
  const paragraph = lastTextParagraph(reply);
  if (!paragraph) return false;
  const text = paragraph
    // 行内的 Markdown：加粗、斜体、行内代码、链接
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    // 列表、引用的开头
    .replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, "")
    .trim()
    // 结尾的表情、空白和别的标点（问号留着）
    .replace(
      /(?:[\s\p{Extended_Pictographic}.。!！…~～、,，;；:：)）\]】"”'’]|\uFE0F|\u200D)+$/u,
      "",
    );
  if (!text) return false;
  const last = lastSentence(text);
  if (POLITE_CLOSINGS.some((re) => re.test(last.replace(/[？?]+$/, "")))) return false;
  return /[？?]$/.test(text) || /[吗呢么]$/.test(text);
}

/** 最后一段不是代码块、不是表格的文字。 */
function lastTextParagraph(reply: string): string | undefined {
  const paragraphs: string[] = [];
  let inFence = false;
  let current: string[] = [];
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) paragraphs.push(text);
    current = [];
  };
  for (const line of reply.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "" || /^\s*\|/.test(line) || /^\s*#{1,6}\s/.test(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return paragraphs.at(-1);
}

/** 一段里最后一句（按句末标点切）。 */
function lastSentence(text: string): string {
  const parts = text.split(/(?<=[。！!？?])\s*/).filter((s) => s.trim());
  return (parts.at(-1) ?? text).trim();
}
