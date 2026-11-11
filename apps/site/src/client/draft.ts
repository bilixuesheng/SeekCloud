import { useCallback, useState } from "react";

const keyOf = (name: string) => `seekcloud:draft:${name}`;

export function readDraft(name: string): string {
  try {
    return localStorage.getItem(keyOf(name)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(name: string, text: string): void {
  try {
    if (text) localStorage.setItem(keyOf(name), text);
    else localStorage.removeItem(keyOf(name));
  } catch {
    // 无痕模式之类写不进去：草稿只留在这个页面里
  }
}

/**
 * 输入框里还没发出去的字。记在浏览器里：换到别的会话再回来、刷新页面、手机把页面回收以后都还在。
 * name 是会话短 ID，首页用 "new"。发出去（设成空）时删掉。
 */
export function useDraft(
  name: string,
): [string, (next: string | ((current: string) => string)) => void] {
  const [text, setText] = useState(() => readDraft(name));
  const set = useCallback(
    (next: string | ((current: string) => string)) => {
      setText((current) => {
        const value = typeof next === "function" ? next(current) : next;
        writeDraft(name, value);
        return value;
      });
    },
    [name],
  );
  return [text, set];
}
