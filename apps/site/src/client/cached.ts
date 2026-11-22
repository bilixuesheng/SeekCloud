import { useCallback, useEffect, useState } from "react";
import { type ApiError, api } from "./api";
import { errorText } from "./i18n/errors";

/**
 * 接口数据的一份浏览器内缓存，设置窗口用：打开设置时把各分类要的数据一起拉好（prefetch），
 * 切到哪个分类都直接有数据，不会先空着、等数据回来再一下子冒出来把内容往下顶。
 * 每次显示时再在后台刷新一次；改了以后用 setCached 把新值写回来，用到它的地方一起更新。
 */
interface Entry {
  value?: unknown;
  inflight?: Promise<unknown>;
  listeners: Set<(value: unknown) => void>;
}

const entries = new Map<string, Entry>();

function entryOf(path: string): Entry {
  let entry = entries.get(path);
  if (!entry) {
    entry = { listeners: new Set() };
    entries.set(path, entry);
  }
  return entry;
}

/** 取一次；同一个地址已经在取了就等那一次，不重复发请求。 */
function load<T>(path: string): Promise<T> {
  const entry = entryOf(path);
  if (entry.inflight) return entry.inflight as Promise<T>;
  const request = api<T>(path)
    .then((value) => {
      setCached(path, value);
      return value;
    })
    .finally(() => {
      if (entry.inflight === request) entry.inflight = undefined;
    });
  entry.inflight = request;
  return request;
}

/** 写回新值（比如改了设置以后），用到这个地址的地方一起更新。 */
export function setCached<T>(path: string, value: T): void {
  const entry = entryOf(path);
  entry.value = value;
  for (const listener of entry.listeners) listener(value);
}

/** 先拉下来放着，出错了不管（真正显示时会再取、再报错）。 */
export function prefetch(paths: string[]): void {
  for (const path of paths) load(path).catch(() => undefined);
}

/** 取接口的数据：缓存里有就先用缓存，同时在后台刷新。 */
export function useCached<T>(path: string): {
  data: T | undefined;
  error: string | undefined;
  reload: () => void;
} {
  const [data, setData] = useState<T | undefined>(() => entryOf(path).value as T | undefined);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    load<T>(path).then(
      () => setError(undefined),
      // 认得的错误按界面语言写（i18n/errors.ts），不认得的用主站给的说明
      (e: ApiError) => setError(errorText(e)),
    );
  }, [path]);

  useEffect(() => {
    const entry = entryOf(path);
    const listener = (value: unknown) => setData(value as T);
    entry.listeners.add(listener);
    if (entry.value !== undefined) setData(entry.value as T);
    reload();
    return () => {
      entry.listeners.delete(listener);
    };
  }, [path, reload]);

  return { data, error, reload };
}
