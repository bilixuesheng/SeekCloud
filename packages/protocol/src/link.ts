// 主站和宿主机之间的连接（WebSocket）：握手、帧、序号和补发。主站（apps/site/src/server/hosts/）和
// 宿主机守护进程（apps/host/src/site-link/）都用这里的定义和 LinkPeer。

import type { HostCommand, HostEvent } from "./index";

/** 宿主机连主站的地址（主站上的路径）。 */
export const HOST_CONNECT_PATH = "/api/hosts/connect";

/**
 * 关连接时用的代码（WebSocket 的 close code，4000 以上是应用自己定的）。
 * 认证失败不区分"没有这台宿主机"和"密钥错误"（都是 UNAUTHORIZED），免得被人拿来试哪些名字存在。
 */
export const LINK_CLOSE = {
  /** 没有密钥、密钥错误、已吊销。宿主机不要自动重连，等管理员换密钥。 */
  UNAUTHORIZED: 4401,
  /** 同一个来源认证失败太多次，过一会儿再连。 */
  RATE_LIMITED: 4429,
  /** 同一个宿主机密钥又连上来一条，这条被顶掉。 */
  REPLACED: 4409,
  /** 第一帧不是握手，或者帧的格式不对。 */
  BAD_FRAME: 4400,
} as const;

/** 宿主机连上以后发的第一帧。 */
export interface HostHello {
  hello: {
    /** 宿主机密钥（pnpm host:create 打印的那一串）。 */
    key: string;
    /** 宿主机说的协议版本，以及它还能说的最旧的版本（见 index.ts 里 PROTOCOL_VERSION 的规矩）。 */
    protocol: number;
    minProtocol: number;
    /** 守护进程的程序版本，给运行状况看。 */
    version: string;
    /** 这次启动的守护进程：每次启动换一个。主站看到它变了，就知道对方重启过，序号从头算。 */
    instance: string;
    /** 宿主机已经处理完的主站帧的最大序号。主站从它后面补发。 */
    ack: number;
  };
}

/** 主站认证通过以后回的第一帧。 */
export interface SiteWelcome {
  welcome: {
    /** 这台宿主机在主站上的名字。 */
    name: string;
    /** 两边都能说的最新版本；两边说不到一起时为 null：连接照样保留，但主站不往这台宿主机派新会话。 */
    protocol: number | null;
    /** 主站的程序版本。 */
    version: string;
    /** 这次启动的主站。宿主机看到它变了，就知道主站重启过，主站的序号从头算。 */
    instance: string;
    /** 主站已经处理完的宿主机帧的最大序号。宿主机从它后面补发。 */
    ack: number;
    credential: HostCredential;
  };
}

/**
 * 宿主机凭据：宿主机替沙箱转发到主站的 HTTP 请求（模型网关、平台工具、自接 MCP）带上它，
 * 放在 Authorization: Bearer 里。连上时下发，有效期内主站会在过期前换一张新的；断线重连也换新的。
 * 主站重启以后旧的全部作废，宿主机重连拿新的。
 */
export interface HostCredential {
  token: string;
  /** ISO 时间。过了这个时间主站不认。 */
  expiresAt: string;
}

/**
 * 宿主机的负载，隔一段时间发一次。只推送、不补发。真的数字在 #18 里采集。
 * 内存和磁盘的单位是字节。
 */
export interface HostReport {
  /** 1 分钟的平均负载。 */
  load: number;
  cpus: number;
  memoryAvailable: number;
  memoryTotal: number;
  diskAvailable: number;
  diskTotal: number;
  /** 正在运行的沙箱数（休眠的不算）。 */
  sandboxes: number;
  /**
   * 单个沙箱的磁盘配额生不生效。现在总是 false（ADR 0005）：Docker 加 Sysbox 在 ext4 上限不住单个容器的磁盘，
   * 沙箱里 Docker 的镜像和卷也不在配额里。运行状况里写明"磁盘配额不生效"，靠宿主机磁盘超过 80% 时先回收
   * 休眠最久的沙箱兜着。旧版本的宿主机不报这一项。
   */
  diskQuota?: boolean;
}

/**
 * 握手以后的一帧（JSON 文本）。
 * - seq 是发送方自己从 1 开始的递增序号，断线重连后接着往下数；只有命令和事件带 seq，会补发。
 * - ack 是已经处理完的对方的最大序号，每一帧都带上；没有别的要发时，单独发一帧只带 ack 的。
 * - 负载和凭据不带 seq，不补发：断了就等下一次。
 * 收到序号不大于已处理的帧时，当作重复，不再处理，只回 ack。序号可以跳：补发的队列太长时，
 * 发送方会丢掉最旧的"只推送、不落库"的帧（进度、增量）。
 */
export type HostLinkFrame =
  | { seq: number; ack: number; command: HostCommand }
  | { seq: number; ack: number; event: HostEvent }
  | { ack: number; report: HostReport }
  | { ack: number; credential: HostCredential }
  | { ack: number };

/** 只推送、不落库的事件：补发的队列满了先丢它们。 */
export const isLiveEvent = (event: HostEvent): boolean =>
  event.type === "progress" || event.type === "delta";

interface Pending<T> {
  seq: number;
  payload: T;
  live: boolean;
}

/**
 * 一端的序号和补发：给要发的帧编号、记着对方还没确认的、认出对方发来的重复帧。
 * 主站对每台宿主机一个（跨断线重连保留），宿主机对主站一个。只管序号，不管网络。
 *
 * 处理顺序：收到一帧 → accept(seq) 为真才处理 → 处理完 processed(seq) → 下一帧带上 ack。
 * 只有处理完才确认：对方收到确认以后就把那一帧从补发队列里删掉了。
 */
export class LinkPeer<T> {
  readonly #maxPending: number;
  readonly #isLive: (payload: T) => boolean;
  #nextSeq = 1;
  #pending: Pending<T>[] = [];
  /** 对方的帧处理到了哪一个。 */
  #received = 0;

  constructor(options: { maxPending: number; isLive?: (payload: T) => boolean }) {
    this.#maxPending = options.maxPending;
    this.#isLive = options.isLive ?? (() => false);
  }

  /** 已经处理完的对方的最大序号：发给对方的 ack。 */
  get received(): number {
    return this.#received;
  }

  /** 还没被对方确认的帧数。 */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /**
   * 编号并记进补发队列。队列超过上限时丢掉最旧的"只推送"的帧；全是要落库的就不丢，宁可多占内存。
   */
  send(payload: T): { seq: number; ack: number; payload: T } {
    const seq = this.#nextSeq++;
    this.#pending.push({ seq, payload, live: this.#isLive(payload) });
    if (this.#pending.length > this.#maxPending) {
      const oldestLive = this.#pending.findIndex((p) => p.live);
      if (oldestLive >= 0) this.#pending.splice(oldestLive, 1);
    }
    return { seq, ack: this.#received, payload };
  }

  /** 对方确认处理到了 ack：这之前的都不用再补发了。 */
  acknowledge(ack: number): void {
    if (this.#pending.length > 0 && this.#pending[0] && this.#pending[0].seq <= ack) {
      this.#pending = this.#pending.filter((p) => p.seq > ack);
    }
  }

  /** 重连以后要补发的：对方还没确认的，按顺序。 */
  unacknowledged(): { seq: number; ack: number; payload: T }[] {
    return this.#pending.map((p) => ({ seq: p.seq, ack: this.#received, payload: p.payload }));
  }

  /** 这一帧是不是新的（没处理过）。 */
  accept(seq: number): boolean {
    return seq > this.#received;
  }

  /** 这一帧处理完了。 */
  processed(seq: number): void {
    if (seq > this.#received) this.#received = seq;
  }

  /** 对方重启过（instance 变了）：它的序号从头算，已处理的位置清零。 */
  peerRestarted(): void {
    this.#received = 0;
  }

  /** 从库里恢复已处理的位置（主站重启以后，同一个宿主机进程重连上来时）。 */
  restoreReceived(seq: number): void {
    this.#received = seq;
  }
}
