/**
 * 置顶消息的短标题：几个字概括这条回复，显示在消息上方和左上角的置顶列表里。
 * Claude 是另调一次便宜的模型生成的；模型网关接上之前先用规则取：回复里有小标题就用第一个小标题，
 * 没有就用最后一段回复里第一句够长的话，这句话前半句（逗号前）够长就只用前半句。
 * 最多 MAX 个字，多了加省略号；不把英文单词、路径截在中间：单词不太长就整个留下，太长就截在它前面。
 */
const MAX = 20;
/** 太短的句子（"收到。""好的。"）不当标题。 */
const MIN = 4;

const plain = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "")
    .trim();

/** 单词、路径最多为了留完整多放这么多个字。 */
const WORD_SLACK = 12;
const WORD = /[A-Za-z0-9_./-]/;

const clip = (text: string) => {
  if (text.length <= MAX) return text;
  let cut = MAX;
  if (WORD.test(text[cut - 1] ?? "") && WORD.test(text[cut] ?? "")) {
    let end = cut;
    while (end < text.length && WORD.test(text[end] ?? "")) end++;
    let start = cut;
    while (start > 0 && WORD.test(text[start - 1] ?? "")) start--;
    if (end - MAX <= WORD_SLACK) cut = end;
    else if (start >= MIN) cut = start;
  }
  const head = text.slice(0, cut).trimEnd();
  return cut >= text.length ? head : `${head}…`;
};

/** texts：这个回合里到这条为止的 Agent 回复，按顺序。 */
export function pinTitle(texts: string[]): string {
  const all = texts.join("\n\n");
  const heading = all.match(/^#{1,6}\s+(.+)$/m);
  if (heading?.[1] && plain(heading[1])) return clip(plain(heading[1]));
  const last = [...texts].reverse().find((t) => t.trim()) ?? "";
  const sentences = last
    .split(/[。！？!?\n]|[.;；](?=\s|$)/)
    .map(plain)
    .filter((s) => s && !s.startsWith("|") && !s.startsWith("```"));
  const pick = sentences.find((s) => s.length >= MIN) ?? sentences[0];
  if (!pick) return "置顶的消息";
  const clause = pick.split(/[，,：:；;]/)[0]?.trim() ?? "";
  return clip(clause.length >= MIN * 2 ? clause : pick);
}
