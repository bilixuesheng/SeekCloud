/**
 * Agent 写到 GitHub 上的正文（issue、PR、评论、review）末尾统一加署名（ADR 0003）。
 * Agent 自己写了、或者改的是已经带署名的正文时，先把已有的署名去掉，保证只出现一次。
 */
export const FOOTER_LINE = "_由 SeekCloud Agent 生成_";

const EXISTING = /(?:\n*-{3,}[ \t]*\n+)?[ \t]*_由 SeekCloud Agent 生成_[ \t]*/g;

export function withFooter(body: string | undefined): string {
  const text = (body ?? "").replace(EXISTING, "").trimEnd();
  return text ? `${text}\n\n---\n${FOOTER_LINE}` : `---\n${FOOTER_LINE}`;
}
