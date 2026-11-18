import { randomUUID } from "node:crypto";
import {
  HOST_CONNECT_PATH,
  type HostCommand,
  type HostCredential,
  type HostEvent,
  type HostReport,
  isLiveEvent,
  LINK_CLOSE,
  LinkPeer,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type SiteWelcome,
} from "@seekcloud/protocol";

/** 主站没确认的事件最多留这么多条；超了先丢最旧的进度、增量（LinkPeer）。 */
const MAX_PENDING = 20_000;
/** 处理完命令以后，这么久里没有别的要发，就单独发一帧确认。 */
const ACK_DELAY_MS = 100;

export interface SiteLinkOptions {
  /** 主站对外的地址，比如 https://seekcloud.example.com（http 换成 ws，https 换成 wss）。 */
  siteUrl: string;
  /** 宿主机密钥（主站上 pnpm host:create 打印的）。 */
  key: string;
  /** 守护进程的程序版本。 */
  version: string;
  /** 主站发来的命令，一个处理完再交下一个。抛错只记日志，照样确认（不然主站会一直补发）。 */
  onCommand: (command: HostCommand) => Promise<void>;
  /** 断线后多久重连：从 initialMs 起每次翻倍，最多 maxMs，再加一点随机。 */
  backoff?: { initialMs: number; maxMs: number };
  log?: (message: string) => void;
}

export function connectUrl(siteUrl: string): string {
  const url = new URL(HOST_CONNECT_PATH, siteUrl);
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  return url.toString();
}

/**
 * 宿主机守护进程到主站的连接（#91）。守护进程主动连上去，用宿主机密钥认证；断了自动重连，
 * 带上自己处理到的序号，双方补发对方没确认的（packages/protocol 的 link.ts）。
 * 主站说认证失败（密钥错了或被吊销）就不再重连，等管理员换密钥重启。
 */
export class SiteLink {
  /** 这次启动的守护进程。主站看到它变了，就知道序号从头算。 */
  readonly instance = randomUUID();
  readonly #options: SiteLinkOptions;
  readonly #peer = new LinkPeer<HostEvent>({ maxPending: MAX_PENDING, isLive: isLiveEvent });
  #socket: WebSocket | undefined;
  #welcome: SiteWelcome["welcome"] | undefined;
  #siteInstance: string | undefined;
  #credential: HostCredential | undefined;
  #stopped = false;
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();
  #log: (message: string) => void;

  constructor(options: SiteLinkOptions) {
    this.#options = options;
    this.#log = options.log ?? ((message) => console.log(message));
  }

  /** 握手完成、连着的时候为真。 */
  get connected(): boolean {
    return this.#welcome !== undefined;
  }

  /** 两边都会说的协议版本；说不到一起时为 null（主站不往这台派新会话）。 */
  get protocol(): number | null | undefined {
    return this.#welcome?.protocol;
  }

  /** 宿主机凭据：替沙箱转发到主站的请求带上它。没连上过时为空。 */
  get credential(): HostCredential | undefined {
    return this.#credential;
  }

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    const socket = this.#socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      });
    }
    await this.#chain;
  }

  /** 上报一个事件。断线时先记着，重连以后补发。 */
  send(event: HostEvent): void {
    const frame = this.#peer.send(event);
    if (this.connected) this.#write({ seq: frame.seq, ack: frame.ack, event });
  }

  /** 上报负载。断线时直接丢掉，等下一次。 */
  report(report: HostReport): void {
    if (this.connected) this.#write({ ack: this.#peer.received, report });
  }

  /** 等处理中的命令都处理完（测试用）。 */
  async idle(): Promise<void> {
    await this.#chain;
  }

  #open(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(connectUrl(this.#options.siteUrl));
    this.#socket = socket;
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          hello: {
            key: this.#options.key,
            protocol: PROTOCOL_VERSION,
            minProtocol: MIN_PROTOCOL_VERSION,
            version: this.#options.version,
            instance: this.instance,
            ack: this.#peer.received,
          },
        }),
      );
    });
    socket.addEventListener("message", (message) => {
      if (this.#socket === socket) this.#onMessage(String(message.data));
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#welcome = undefined;
      if (this.#ackTimer) clearTimeout(this.#ackTimer);
      this.#ackTimer = undefined;
      if (event.code === LINK_CLOSE.UNAUTHORIZED) {
        this.#log(
          "主站拒绝了宿主机密钥（密钥错误或已被吊销），不再重连。请检查 SEEKCLOUD_HOST_KEY。",
        );
        this.#stopped = true;
        return;
      }
      this.#scheduleReconnect(event.code === LINK_CLOSE.RATE_LIMITED);
    });
    // 连不上时浏览器风格的 WebSocket 先报 error 再报 close，重连在 close 里做。
    socket.addEventListener("error", () => undefined);
  }

  #scheduleReconnect(slow: boolean): void {
    if (this.#stopped) return;
    const { initialMs, maxMs } = this.#options.backoff ?? { initialMs: 1000, maxMs: 30_000 };
    const base = Math.min(maxMs, initialMs * 2 ** this.#attempt);
    this.#attempt++;
    const wait = (slow ? maxMs : base) * (0.8 + Math.random() * 0.4);
    this.#retry = setTimeout(() => this.#open(), wait);
  }

  #onMessage(data: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data);
    } catch {
      this.#log("主站发来的帧不是 JSON，已忽略");
      return;
    }
    if (frame.welcome) {
      this.#onWelcome(frame.welcome as SiteWelcome["welcome"]);
      return;
    }
    if (typeof frame.ack === "number") this.#peer.acknowledge(frame.ack);
    if (frame.credential) this.#credential = frame.credential as HostCredential;
    if (typeof frame.seq !== "number" || !frame.command) return;
    const seq = frame.seq;
    const command = frame.command as HostCommand;
    if (!this.#peer.accept(seq)) {
      this.#scheduleAck();
      return;
    }
    this.#chain = this.#chain.then(async () => {
      if (!this.#peer.accept(seq)) return;
      try {
        await this.#options.onCommand(command);
      } catch (error) {
        this.#log(`处理主站的命令 ${command.type} 失败：${String(error)}`);
      }
      this.#peer.processed(seq);
      this.#scheduleAck();
    });
  }

  #onWelcome(welcome: SiteWelcome["welcome"]): void {
    if (this.#siteInstance !== undefined && this.#siteInstance !== welcome.instance) {
      // 主站重启过：它的序号从 1 重新数。
      this.#peer.peerRestarted();
    }
    this.#siteInstance = welcome.instance;
    this.#welcome = welcome;
    this.#credential = welcome.credential;
    this.#attempt = 0;
    this.#peer.acknowledge(welcome.ack);
    if (welcome.protocol === null) {
      this.#log(
        `主站（${welcome.version}）的协议版本和宿主机（${MIN_PROTOCOL_VERSION}–${PROTOCOL_VERSION}）说不到一起：` +
          "连接保留，但主站不会派新会话。请把两边更新到相近的版本。",
      );
    } else {
      this.#log(`已连上主站，宿主机名为 ${welcome.name}，协议版本 ${welcome.protocol}`);
    }
    for (const frame of this.#peer.unacknowledged()) {
      this.#write({ seq: frame.seq, ack: frame.ack, event: frame.payload });
    }
  }

  #write(frame: object): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    socket.send(JSON.stringify(frame));
  }

  #scheduleAck(): void {
    if (this.#ackTimer || !this.connected) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = undefined;
      this.#write({ ack: this.#peer.received });
    }, ACK_DELAY_MS);
  }
}
