import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** 运行器（apps/host/sandbox/runner/seekcloud-runner.mjs）发来的一条，编号从 1 起。 */
export type RunnerEntry = { seq: number } & (
  | { type: "rpc"; line: string }
  | { type: "live"; line: string }
  | { type: "stderr"; text: string }
  | { type: "started"; pid: number }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; text: string }
);

export interface RunnerWelcome {
  instance: string;
  running: boolean;
  pid: number | null;
  /** 有一段条目在运行器那里已经丢了（太久没确认）。 */
  gap: boolean;
}

export type RunnerOp =
  | { op: "start"; args: string[]; cwd?: string; env?: Record<string, string> }
  | { op: "send"; line: string }
  | { op: "stop"; graceMs?: number };

export interface RunnerLinkOptions {
  /** 怎么连上运行器：一条命令，它的标准输入输出就是运行器的套接字（沙箱里是 docker exec -i …）。 */
  bridge: () => string[];
  /** 每一条按编号顺序交给它，处理完（Promise 落定）才确认、才交下一条。 */
  onEntry: (entry: RunnerEntry) => void | Promise<void>;
  /** 每次连上（包括重连）。instanceChanged：运行器重启过，之前的 dsh 已经没了。 */
  onWelcome?: (welcome: RunnerWelcome, instanceChanged: boolean) => void | Promise<void>;
  log?: (message: string) => void;
  /** 断了以后隔多久重连。 */
  retryMs?: number;
}

/**
 * 守护进程到沙箱里运行器的连接（#25）。断了自动重连，重连时带上处理到的编号，运行器补发后面的；
 * 同一个编号只交给 onEntry 一次。连着时发的操作直接写过去；没连着时先攒着，连上以后按顺序发。
 */
export class RunnerLink {
  readonly #options: RunnerLinkOptions;
  #process: ChildProcess | undefined;
  #connected = false;
  #stopped = false;
  #lastSeq = 0;
  #instance: string | undefined;
  #pending: RunnerOp[] = [];
  #chain: Promise<void> = Promise.resolve();
  #retry: NodeJS.Timeout | undefined;

  constructor(options: RunnerLinkOptions) {
    this.#options = options;
  }

  get connected(): boolean {
    return this.#connected;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  /** 断开（运行器和 dsh 照常跑）。 */
  stop(): void {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#process?.kill();
    this.#process = undefined;
    this.#connected = false;
  }

  send(op: RunnerOp): void {
    if (this.#connected && this.#process?.stdin?.writable) {
      this.#process.stdin.write(`${JSON.stringify(op)}\n`);
    } else {
      this.#pending.push(op);
    }
  }

  /** 等已经收到的条目都处理完。 */
  idle(): Promise<void> {
    return this.#chain;
  }

  #connect(): void {
    if (this.#stopped) return;
    const [file, ...args] = this.#options.bridge();
    if (!file) throw new Error("没有连运行器的命令");
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#process = child;
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d: Buffer) => this.#log(`运行器连接：${String(d).trim()}`));
    child.on("error", (error) => this.#log(`连不上运行器：${error.message}`));
    child.on("close", () => {
      if (this.#process !== child) return;
      this.#process = undefined;
      this.#connected = false;
      if (!this.#stopped) {
        this.#retry = setTimeout(() => this.#connect(), this.#options.retryMs ?? 500);
        this.#retry.unref();
      }
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(child, line));
    child.stdin.write(`${JSON.stringify({ op: "hello", since: this.#lastSeq })}\n`);
  }

  #onLine(child: ChildProcess, line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.op === "welcome") {
      const welcome = frame as unknown as RunnerWelcome;
      const changed = this.#instance !== undefined && this.#instance !== welcome.instance;
      if (changed) {
        // 运行器重启过：编号从 1 重新数
        this.#lastSeq = 0;
      }
      this.#instance = welcome.instance;
      if (welcome.gap) this.#log("运行器那边有一段输出已经丢了（太久没确认）");
      this.#connected = true;
      const pending = this.#pending.splice(0);
      this.#chain = this.#chain
        .then(() => this.#options.onWelcome?.(welcome, changed))
        .catch((error) => this.#log(`处理运行器的欢迎失败：${String(error)}`));
      for (const op of pending) child.stdin?.write(`${JSON.stringify(op)}\n`);
      return;
    }
    const seq = frame.seq;
    if (typeof seq !== "number") return;
    const entry = frame as unknown as RunnerEntry;
    this.#chain = this.#chain.then(async () => {
      if (seq <= this.#lastSeq) return; // 重连补发的、已经处理过的
      try {
        await this.#options.onEntry(entry);
      } catch (error) {
        this.#log(`处理运行器的第 ${seq} 条失败：${String(error)}`);
      }
      this.#lastSeq = seq;
      if (this.#process === child && this.#connected) {
        child.stdin?.write(`${JSON.stringify({ op: "ack", seq })}\n`);
      }
    });
  }

  #log(message: string): void {
    (this.#options.log ?? ((m) => console.log(m)))(message);
  }
}
