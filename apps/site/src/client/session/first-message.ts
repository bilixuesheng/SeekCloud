/**
 * 首页发起会话时的第一条消息：会话页一挂上就先显示出来（和会话里刚发、服务器还没回推的消息一样），
 * 不等事件流回来。这样换页过渡拍"新页面"那张画面时，消息气泡和底部的鲸鱼已经在最终的位置上，
 * 鲸鱼从首页中间直接挪过去，不会先到顶上、等消息出来再被往下推。
 */
let first: { id: string; text: string; at: string } | undefined;

/** 首页发起会话成功、换页之前调用。 */
export function handOffFirstMessage(id: string, text: string): void {
  first = { id, text, at: new Date().toISOString() };
}

/** 会话页挂上时取一次；不是这个会话的、或者是很久以前留下的，都不算。 */
export function firstMessageOf(id: string): { text: string; at: string } | undefined {
  if (!first || first.id !== id) return undefined;
  if (Date.now() - Date.parse(first.at) > 30_000) return undefined;
  return { text: first.text, at: first.at };
}
