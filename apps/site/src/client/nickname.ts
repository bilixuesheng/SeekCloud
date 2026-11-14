/**
 * 浏览器里记一份昵称：页面一打开、还没问过服务器时，首页的问候语就能先挑好、先拉字体（main.tsx）。
 * 读写失败（无痕模式之类）就当没有。
 */
const KEY = "seekcloud:nickname";

export function rememberedNickname(): string | null {
  try {
    return localStorage.getItem(KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function rememberNickname(nickname: string | null): void {
  try {
    if (nickname) localStorage.setItem(KEY, nickname);
    else localStorage.removeItem(KEY);
  } catch {}
}
