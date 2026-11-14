import { useEffect, useState } from "react";

const SERIF = '600 1em "Noto Serif SC"';

/** 先把这几个字要用的衬线字体分片拉下来（比如首页的问候语，在页面画出来之前就开始拉）。 */
export function preloadSerif(text: string): void {
  if ("fonts" in document) document.fonts.load(SERIF, text).catch(() => undefined);
}

/**
 * 衬线字体按需分片加载，第一次显示某些字时要等一会儿。直接显示的话，会先用系统字体、再跳成思源宋体，看着很糙。
 * 这里等这几个字的字体到了再显示（最多等 400 毫秒，超时就先用系统字体）；已经缓存过就立刻显示。
 */
export function useSerifReady(text: string): boolean {
  const [ready, setReady] = useState(
    () => !("fonts" in document) || document.fonts.check(SERIF, text),
  );
  useEffect(() => {
    if (ready) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setReady(true);
    };
    document.fonts.load(SERIF, text).then(finish, finish);
    const timer = setTimeout(finish, 400);
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [ready, text]);
  return ready;
}
