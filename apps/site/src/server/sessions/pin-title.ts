/**
 * 置顶消息的短标题：几个字概括这条回复，显示在消息上方和左上角的置顶列表里。
 * Claude 是另调一次便宜的模型生成的；模型网关接上之前先用规则取：回复里有小标题就用第一个小标题，
 * 没有就用最后一段回复里第一句够长的话。最多 MAX 个字，多了加省略号。
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

const clip = (text: string) => (text.length > MAX ? `${text.slice(0, MAX)}…` : text);

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
  return pick ? clip(pick) : "置顶的消息";
}
