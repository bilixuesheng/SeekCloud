/** 进程内的订阅和通知。主站只有一个进程，事件流的实时推送靠它。 */
export class Topic<T> {
  readonly #listeners = new Map<string, Set<(value: T) => void>>();

  /** 返回取消订阅的函数。 */
  on(key: string, listener: (value: T) => void): () => void {
    let set = this.#listeners.get(key);
    if (!set) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(key);
    };
  }

  emit(key: string, value: T): void {
    for (const listener of this.#listeners.get(key) ?? []) listener(value);
  }
}

/**
 * 把 run 包成"催一下就跑"的函数：同一时间只跑一个；跑的时候又被催了，跑完再跑一遍。
 * 事件流用它按顺序读库、推送，不会乱序也不会漏。
 */
export function serial(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await run();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
}
