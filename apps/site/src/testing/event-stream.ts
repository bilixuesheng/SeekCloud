export interface StreamedEvent {
  event: string;
  id?: string;
  data: string;
}

/** 读一条 SSE 响应。用完记得 close，否则服务器那边的推送一直开着。 */
export class EventStreamReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  readonly #queue: StreamedEvent[] = [];

  constructor(res: Response) {
    if (!res.body) throw new Error("响应没有内容");
    this.#reader = res.body.getReader();
  }

  /** 下一条事件（跳过注释行）。等太久就报错。 */
  async next(timeoutMs = 2000): Promise<StreamedEvent> {
    const deadline = Date.now() + timeoutMs;
    while (this.#queue.length === 0) {
      const remaining = deadline - Date.now();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("等事件超时")), Math.max(remaining, 0));
      });
      const chunk = await Promise.race([this.#reader.read(), timeout]).finally(() =>
        clearTimeout(timer),
      );
      if (chunk.done) throw new Error("事件流已经结束");
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
      this.#parse();
    }
    return this.#queue.shift() as StreamedEvent;
  }

  /** 读到满足条件的那条为止，返回一路读到的所有事件（含那一条）。 */
  async until(match: (event: StreamedEvent) => boolean): Promise<StreamedEvent[]> {
    const seen: StreamedEvent[] = [];
    for (;;) {
      const event = await this.next();
      seen.push(event);
      if (match(event)) return seen;
    }
  }

  async close(): Promise<void> {
    await this.#reader.cancel();
  }

  #parse(): void {
    let end = this.#buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      const event: StreamedEvent = { event: "message", data: "" };
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event.event = value;
        else if (field === "id") event.id = value;
        else if (field === "data") data.push(value);
      }
      event.data = data.join("\n");
      if (data.length > 0 || event.id !== undefined) this.#queue.push(event);
      end = this.#buffer.indexOf("\n\n");
    }
  }
}
