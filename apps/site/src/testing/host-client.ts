import { randomUUID } from "node:crypto";
import {
  HOST_CONNECT_PATH,
  type HostCommand,
  type HostCredential,
  type HostEvent,
  type HostReport,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type SiteWelcome,
} from "@seekcloud/protocol";
import WebSocket from "ws";

type CommandOf<T extends HostCommand["type"]> = Extract<HostCommand, { type: T }>;

export interface TestHostOptions {
  key: string;
  protocol?: number;
  minProtocol?: number;
  version?: string;
  /** 守护进程这次启动的标识。重启就换一个（restart()）。 */
  instance?: string;
  /** 连接时带的 X-Forwarded-For（测按来源限速）。 */
  forwardedFor?: string;
}

/**
 * 测试里扮演宿主机守护进程：按协议连主站的 HostHub，记下收到的命令，替测试发事件。
 * 序号自己管，也可以手动指定（测重复、补发）。收到命令就算处理完了，下一帧带上 ack。
 */
export class TestHostClient {
  readonly #url: string;
  readonly #options: TestHostOptions;
  #instance: string;
  #socket: WebSocket | undefined;
  /** 收到的命令（不重复的）和它们的序号。 */
  readonly commands: { seq: number; command: HostCommand }[] = [];
  /** 每一帧原样记下（包括重复的），测补发用。 */
  readonly frames: unknown[] = [];
  welcome: SiteWelcome["welcome"] | undefined;
  credential: HostCredential | undefined;
  closed: { code: number; reason: string } | undefined;
  /** 处理完的主站帧的最大序号。 */
  received = 0;
  #nextSeq = 1;
  /** 发出去的事件，主站还没确认的；reconnect 时补发。 */
  readonly #unacked: { seq: number; event: HostEvent }[] = [];
  #waiters: (() => void)[] = [];

  constructor(url: string, options: TestHostOptions) {
    this.#url = url;
    this.#options = options;
    this.#instance = options.instance ?? randomUUID();
  }

  /** 连上并握手。返回主站的欢迎帧；被拒绝时返回关连接的代码。 */
  connect(ack = this.received): Promise<SiteWelcome["welcome"] | { code: number }> {
    this.welcome = undefined;
    this.closed = undefined;
    const headers = this.#options.forwardedFor
      ? { "x-forwarded-for": this.#options.forwardedFor }
      : undefined;
    const socket = new WebSocket(`${this.#url}${HOST_CONNECT_PATH}`, { headers });
    this.#socket = socket;
    return new Promise((resolve) => {
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            hello: {
              key: this.#options.key,
              protocol: this.#options.protocol ?? PROTOCOL_VERSION,
              minProtocol: this.#options.minProtocol ?? MIN_PROTOCOL_VERSION,
              version: this.#options.version ?? "test-host",
              instance: this.#instance,
              ack,
            },
          }),
        ),
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data));
        this.frames.push(frame);
        if (frame.welcome) {
          this.welcome = frame.welcome;
          this.credential = frame.welcome.credential;
          this.#acknowledge(frame.welcome.ack);
          resolve(frame.welcome);
        } else {
          if (typeof frame.ack === "number") this.#acknowledge(frame.ack);
          if (frame.credential) this.credential = frame.credential;
          if (frame.command && frame.seq > this.received) {
            this.received = frame.seq;
            this.commands.push({ seq: frame.seq, command: frame.command });
          }
        }
        this.#wake();
      });
      socket.on("close", (code, reason) => {
        this.closed = { code, reason: String(reason) };
        resolve({ code });
        this.#wake();
      });
      socket.on("error", () => undefined);
    });
  }

  /** 守护进程这次启动的标识。 */
  get instance(): string {
    return this.#instance;
  }

  /** 断开（不关进程，状态都留着）。 */
  async disconnect(): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState === socket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  /** 守护进程重启：换一个标识，收到的、没确认的都忘掉，序号从 1 重新数。 */
  restart(): void {
    this.#instance = randomUUID();
    this.received = 0;
    this.#nextSeq = 1;
    this.#unacked.length = 0;
  }

  /** 上报一个事件。seq 不给就自己往下数。 */
  sendEvent(event: HostEvent, seq?: number): number {
    const n = seq ?? this.#nextSeq++;
    if (seq === undefined) this.#unacked.push({ seq: n, event });
    this.send({ seq: n, ack: this.received, event });
    return n;
  }

  /** 补发主站没确认的事件（握手以后调用）。 */
  resendUnacked(): void {
    for (const { seq, event } of this.#unacked) this.send({ seq, ack: this.received, event });
  }

  get unackedCount(): number {
    return this.#unacked.length;
  }

  sendReport(report: HostReport): void {
    this.send({ ack: this.received, report });
  }

  /** 原样发一帧（测格式不对的帧）。 */
  send(frame: unknown): void {
    this.#socket?.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** 等收到某种命令（第 n 个，从 1 数），返回它。 */
  async command<T extends HostCommand["type"]>(type: T, nth = 1): Promise<CommandOf<T>> {
    await this.until(() => this.commands.filter((c) => c.command.type === type).length >= nth);
    return this.commands.filter((c) => c.command.type === type)[nth - 1]?.command as CommandOf<T>;
  }

  /** 等条件成立，最多 2 秒。 */
  async until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("等太久了");
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }

  #acknowledge(ack: number): void {
    const keep = this.#unacked.filter((u) => u.seq > ack);
    this.#unacked.length = 0;
    this.#unacked.push(...keep);
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}
