import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import {
  HOST_CONNECT_PATH,
  type HostCommand,
  type HostCredential,
  type HostEvent,
  type HostHello,
  type HostReport,
  isLiveEvent,
  LINK_CLOSE,
  LinkPeer,
  MIN_PROTOCOL_VERSION,
  negotiateProtocol,
  PROTOCOL_VERSION,
} from "@seekcloud/protocol";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type WebSocket, WebSocketServer } from "ws";
import { networkOf } from "../access-log";
import type { AppDeps } from "../app";
import { hosts, sessions } from "../db/schema";
import { clientAddress, HOUR, RateLimiter } from "../rate-limit";
import type { HostLink } from "../sessions/host";
import { readSetting } from "../settings";
import { parseFrame, parseHello } from "./frames";
import { findHostByKey, revokeHost } from "./keys";

/** 每台宿主机最多留这么多条对方没确认的命令。超了先丢"只推送"的（命令里没有），见 LinkPeer。 */
const MAX_PENDING = 10_000;
/** 连上以后这么久还没发握手就断开。 */
const HELLO_TIMEOUT_MS = 10_000;
/** 收到帧以后，这么久里没有别的要发，就单独发一帧确认。 */
const ACK_DELAY_MS = 100;
/** 宿主机凭据的有效期；还剩不到一半时换一张新的。 */
const CREDENTIAL_TTL_MS = HOUR;
/** 定时检查：吊销、断线太久、换凭据。 */
const TICK_MS = 5_000;
/** 同一个来源认证失败的上限：一小时 20 次。 */
const AUTH_FAILURES = { limit: 20, windowMs: HOUR };

type HubDeps = Pick<AppDeps, "db" | "clock" | "version" | "settingsPolicy">;

interface Connection {
  socket: WebSocket;
  /** 两边都会说的版本；null 表示说不到一起，不派新会话。 */
  protocol: number | null;
  version: string;
}

interface HostState {
  id: string;
  name: string;
  /** 主站发给这台宿主机的命令：序号和补发。跨断线重连保留。 */
  peer: LinkPeer<HostCommand>;
  /** 守护进程这次启动的标识（握手里带的）。变了说明它重启过。 */
  instance: string | null;
  connection?: Connection;
  /** 断线的时间；连着时为空。主站刚启动、还没连上来的宿主机，从启动时算。 */
  offlineSince?: Date;
  revoked: boolean;
  report?: HostReport;
  /** 这台宿主机的事件一个个处理，前一个处理完再交下一个。 */
  chain: Promise<void>;
  ackTimer?: ReturnType<typeof setTimeout>;
  /** 最新一张凭据的过期时间。 */
  credentialExpiresAt?: number;
}

/** 给运行状况（#46）看的。 */
export interface HostStatus {
  name: string;
  connected: boolean;
  /** 两边都会说的协议版本；说不到一起时为 null（不接新会话）。没连着时为 undefined。 */
  protocol?: number | null;
  version?: string;
  offlineSince?: string;
  report?: HostReport;
}

/**
 * 管着所有宿主机的连接（ADR 0010 不分版本：宿主机和协议没有扩展点）。
 *
 * - 宿主机守护进程主动连上来（WebSocket，HOST_CONNECT_PATH），第一帧带宿主机密钥认证；
 * - 命令和事件带序号，断线重连后补发对方没确认的，重复的只处理一次（LinkPeer）；
 * - 记着每个会话在哪台宿主机上（sessions.host_id），宿主机只能上报自己名下的会话；
 * - 宿主机断线超过设置里的时长（默认 2 分钟），把它上面运行中的会话标为失败；吊销的立即断开。
 */
export class HostHub implements HostLink {
  readonly #deps: HubDeps;
  /** 这次启动的主站。宿主机看到它变了，就知道主站的序号从头算。 */
  readonly #instance = randomUUID();
  readonly #states = new Map<string, HostState>();
  /** 会话 → 宿主机。派会话时记下，查过库的也缓存在这里。 */
  readonly #sessionHost = new Map<string, string>();
  readonly #credentials = new Map<string, { hostId: string; expiresAt: number }>();
  readonly #limiter: RateLimiter;
  #onEvent: ((event: HostEvent) => Promise<void>) | undefined;
  #onAvailable: (() => void) | undefined;
  /** 发命令排成一队：派会话要先写库，后面同一个会话的命令不能抢到前面。 */
  #sendChain: Promise<void> = Promise.resolve();
  #wss: WebSocketServer | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: HubDeps) {
    this.#deps = deps;
    this.#limiter = new RateLimiter(deps.clock);
  }

  connect(onEvent: (event: HostEvent) => Promise<void>, onAvailable?: () => void): void {
    this.#onEvent = onEvent;
    this.#onAvailable = onAvailable;
  }

  available(): boolean {
    return [...this.#states.values()].some((s) => s.connection && s.connection.protocol !== null);
  }

  /**
   * 主站启动时调用：把库里的宿主机都登记成"断线中"（从现在算），开始定时检查。
   * 主站重启前派出去的会话，宿主机重连上来就接着走；一直不回来的，过了时长标为失败。
   */
  async start(options: { tick?: boolean } = {}): Promise<void> {
    const rows = await this.#deps.db.select().from(hosts).where(isNull(hosts.revokedAt));
    for (const row of rows) {
      const state = this.#state(row.id, row.name, row.instance);
      state.peer.restoreReceived(row.lastReceivedSeq);
    }
    if (options.tick !== false) this.#timer = setInterval(() => void this.tick(), TICK_MS);
  }

  /** 接到主站的 HTTP 服务上：只处理 HOST_CONNECT_PATH 的升级请求。 */
  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    this.#wss = wss;
    server.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== HOST_CONNECT_PATH) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, req));
    });
  }

  /** 停下：断开所有连接，不再定时检查。 */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    for (const state of this.#states.values()) {
      if (state.ackTimer) clearTimeout(state.ackTimer);
      state.connection?.socket.terminate();
    }
    await new Promise<void>((resolve) =>
      this.#wss ? this.#wss.close(() => resolve()) : resolve(),
    );
  }

  send(command: HostCommand): void {
    this.#sendChain = this.#sendChain
      .then(() => this.#route(command))
      .catch((error) => console.error("给宿主机发命令失败", command.type, error));
  }

  /** 等排着的命令都发出去（测试用）。 */
  async flush(): Promise<void> {
    await this.#sendChain;
    await Promise.all([...this.#states.values()].map((s) => s.chain));
  }

  /** 定时检查：吊销的断开、断线太久的把会话标为失败、凭据快过期的换新的。 */
  async tick(): Promise<void> {
    await this.checkRevocations();
    await this.sweep();
    this.#renewCredentials();
  }

  /** 吊销一台宿主机（以后网页上的"删除宿主机"用）：库里记下，已有的连接立即断开。 */
  async revoke(name: string): Promise<boolean> {
    const done = await revokeHost(this.#deps.db, name, this.#deps.clock.now());
    await this.checkRevocations();
    return done;
  }

  /** 库里被吊销了的（可能是命令行吊销的），断开连接、作废凭据，名下运行中的会话马上标为失败。 */
  async checkRevocations(): Promise<void> {
    const ids = [...this.#states.keys()];
    if (ids.length === 0) return;
    const revoked = await this.#deps.db
      .select({ id: hosts.id })
      .from(hosts)
      .where(and(inArray(hosts.id, ids), isNotNull(hosts.revokedAt)));
    for (const { id } of revoked) {
      const state = this.#states.get(id);
      if (!state || state.revoked) continue;
      state.revoked = true;
      state.offlineSince ??= this.#deps.clock.now();
      for (const [token, entry] of this.#credentials) {
        if (entry.hostId === id) this.#credentials.delete(token);
      }
      if (state.connection) {
        const { socket } = state.connection;
        state.connection = undefined;
        socket.close(LINK_CLOSE.UNAUTHORIZED, "unauthorized");
      }
      console.warn(`宿主机 ${state.name} 已被吊销，连接已断开`);
    }
    if (revoked.length > 0) await this.sweep();
  }

  /**
   * 断线超过设置的时长（host_offline_grace，按会话的主人读）的宿主机：把它上面运行中的会话标为失败。
   * 吊销了的不等。断线期间沙箱里的运行器还在跑，重连得上的话事件会补上，所以不急着标。
   */
  async sweep(): Promise<void> {
    const now = this.#deps.clock.now().getTime();
    for (const state of this.#states.values()) {
      if (state.connection || !state.offlineSince) continue;
      const offlineMs = now - state.offlineSince.getTime();
      const running = await this.#deps.db
        .select({ id: sessions.id, userId: sessions.userId })
        .from(sessions)
        .where(and(eq(sessions.hostId, state.id), eq(sessions.status, "running")));
      for (const session of running) {
        const grace = state.revoked
          ? 0
          : (await readSetting(this.#deps, "host_offline_grace", { userId: session.userId })) *
            1000;
        if (offlineMs < grace) continue;
        await this.#enqueueEvent(state, {
          type: "sandbox.failed",
          sessionId: session.id,
          error: { code: "sandbox_unavailable" },
        });
      }
    }
  }

  /** 宿主机凭据：宿主机替沙箱转发到主站的请求带上它（hosts/credential.ts 的中间件用）。 */
  verifyCredential(token: string): { id: string; name: string } | undefined {
    const entry = this.#credentials.get(token);
    if (!entry || entry.expiresAt <= this.#deps.clock.now().getTime()) return undefined;
    const state = this.#states.get(entry.hostId);
    if (!state || state.revoked) return undefined;
    return { id: state.id, name: state.name };
  }

  status(): HostStatus[] {
    return [...this.#states.values()]
      .filter((s) => !s.revoked)
      .map((s) => ({
        name: s.name,
        connected: s.connection !== undefined,
        protocol: s.connection?.protocol,
        version: s.connection?.version,
        offlineSince: s.offlineSince?.toISOString(),
        report: s.report,
      }));
  }

  // ---- 连接 ----

  #accept(socket: WebSocket, req: IncomingMessage): void {
    socket.on("error", () => undefined);
    // 和接口的频率限制一样，按设置里"主站前面有几层反向代理"取来源地址（握手时再读设置）
    const from = { forwardedFor: req.headers["x-forwarded-for"], remote: req.socket.remoteAddress };
    const timeout = setTimeout(
      () => socket.close(LINK_CLOSE.BAD_FRAME, "hello expected"),
      HELLO_TIMEOUT_MS,
    );
    socket.once("message", (data) => {
      clearTimeout(timeout);
      const hello = parseHello(data);
      if (!hello) {
        socket.close(LINK_CLOSE.BAD_FRAME, "hello expected");
        return;
      }
      this.#handshake(socket, from, hello).catch((error) => {
        console.error("宿主机握手失败", error);
        socket.close(1011, "internal error");
      });
    });
    socket.once("close", () => clearTimeout(timeout));
  }

  async #handshake(
    socket: WebSocket,
    from: { forwardedFor: string | string[] | undefined; remote: string | undefined },
    { hello }: HostHello,
  ): Promise<void> {
    const hops = await readSetting(this.#deps, "proxy_hops", { userId: null });
    const ip = clientAddress(from.forwardedFor, from.remote, hops);
    // 只数失败的：认证通过就退回这一次。不区分"没有这台宿主机"和"密钥错误"。
    const rules = [{ key: `host-auth:${networkOf(ip)}`, ...AUTH_FAILURES }];
    if (this.#limiter.take(rules) > 0) {
      socket.close(LINK_CLOSE.RATE_LIMITED, "rate limited");
      return;
    }
    const row = await findHostByKey(this.#deps.db, hello.key);
    if (!row) {
      socket.close(LINK_CLOSE.UNAUTHORIZED, "unauthorized");
      return;
    }
    this.#limiter.release(rules);
    if (socket.readyState !== socket.OPEN) return;

    const state = this.#state(row.id, row.name, row.instance);
    state.revoked = false;
    if (state.instance !== hello.instance) {
      // 守护进程重启过：它的序号从 1 重新数。
      state.peer.peerRestarted();
      state.instance = hello.instance;
    }
    // 同一把密钥后连上的顶掉先连上的。
    const old = state.connection;
    state.connection = undefined;
    old?.socket.close(LINK_CLOSE.REPLACED, "replaced");

    const protocol = negotiateProtocol(
      { protocol: PROTOCOL_VERSION, minProtocol: MIN_PROTOCOL_VERSION },
      hello,
    );
    if (protocol === null) {
      console.warn(
        `宿主机 ${row.name} 的协议版本 ${hello.minProtocol}–${hello.protocol} 和主站的 ` +
          `${MIN_PROTOCOL_VERSION}–${PROTOCOL_VERSION} 说不到一起：连接保留，不派新会话`,
      );
    }
    const wasAvailable = this.available();
    state.connection = { socket, protocol, version: hello.version };
    state.offlineSince = undefined;
    state.peer.acknowledge(hello.ack);

    this.#write(state, {
      welcome: {
        name: row.name,
        protocol,
        version: this.#deps.version,
        instance: this.#instance,
        ack: state.peer.received,
        credential: this.#issueCredential(state),
      },
    });
    for (const frame of state.peer.unacknowledged()) {
      this.#write(state, { seq: frame.seq, ack: frame.ack, command: frame.payload });
    }
    socket.on("message", (data) => this.#onMessage(state, socket, data));
    socket.on("close", () => this.#onClose(state, socket));

    await this.#deps.db
      .update(hosts)
      .set({
        lastSeenAt: this.#deps.clock.now(),
        protocol: hello.protocol,
        version: hello.version,
        instance: hello.instance,
      })
      .where(eq(hosts.id, row.id));
    if (protocol !== null && !wasAvailable) this.#onAvailable?.();
  }

  #onClose(state: HostState, socket: WebSocket): void {
    // 被新连接顶掉的旧连接关掉时不算断线。
    if (state.connection?.socket !== socket) return;
    state.connection = undefined;
    state.offlineSince = this.#deps.clock.now();
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = undefined;
  }

  #onMessage(state: HostState, socket: WebSocket, data: unknown): void {
    if (state.connection?.socket !== socket) return;
    const frame = parseFrame(data);
    if (!frame) {
      console.warn(`宿主机 ${state.name} 发来的帧格式不对，断开连接`);
      socket.close(LINK_CLOSE.BAD_FRAME, "bad frame");
      return;
    }
    state.peer.acknowledge(frame.ack);
    if ("report" in frame) state.report = frame.report;
    if (!("seq" in frame)) return;
    const { seq, event } = frame;
    if (!state.peer.accept(seq)) {
      this.#scheduleAck(state);
      return;
    }
    state.chain = state.chain.then(async () => {
      // 断线重连时同一帧可能排进来两次：处理时再看一遍。
      if (!state.peer.accept(seq)) return;
      try {
        await this.#handleEvent(state, event);
      } catch (error) {
        // 主站这边出错（比如库连不上）：不确认，断开让宿主机重连后补发，免得后面的事件抢到前面。
        console.error(`处理宿主机 ${state.name} 的事件失败`, error);
        state.connection?.socket.close(1011, "internal error");
        return;
      }
      state.peer.processed(seq);
      if (event === "unknown" || event === "invalid" || !isLiveEvent(event)) {
        await this.#deps.db
          .update(hosts)
          .set({ lastReceivedSeq: state.peer.received })
          .where(eq(hosts.id, state.id));
      }
      this.#scheduleAck(state);
    });
  }

  async #handleEvent(state: HostState, event: HostEvent | "unknown" | "invalid"): Promise<void> {
    if (event === "unknown") {
      console.warn(`宿主机 ${state.name} 发来不认识的事件类型（可能比主站新），已忽略`);
      return;
    }
    if (event === "invalid") {
      console.warn(`宿主机 ${state.name} 发来的事件格式不对，已忽略`);
      return;
    }
    if (!(await this.owns(state.id, event.sessionId))) {
      console.warn(`宿主机 ${state.name} 上报了不在它名下的会话 ${event.sessionId}，已忽略`);
      return;
    }
    await this.#onEvent?.(event);
  }

  /** 这个会话是不是在这台宿主机上。 */
  async owns(hostId: string, sessionId: string): Promise<boolean> {
    return (await this.#hostOf(sessionId)) === hostId;
  }

  async #hostOf(sessionId: string): Promise<string | undefined> {
    const cached = this.#sessionHost.get(sessionId);
    if (cached) return cached;
    if (!UUID.test(sessionId)) return undefined;
    const [row] = await this.#deps.db
      .select({ hostId: sessions.hostId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (row?.hostId) this.#sessionHost.set(sessionId, row.hostId);
    return row?.hostId ?? undefined;
  }

  /** 主站自己造的事件（断线太久、吊销）也排进这台宿主机的队列，和它上报的事件按顺序处理。 */
  #enqueueEvent(state: HostState, event: HostEvent): Promise<void> {
    state.chain = state.chain
      .then(() => this.#onEvent?.(event))
      .catch((error) => {
        console.error("处理宿主机的事件失败", error);
      });
    return state.chain;
  }

  // ---- 发命令 ----

  async #route(command: HostCommand): Promise<void> {
    if (command.type === "prepare_sandbox") {
      // 唤醒休眠的会话时尽量回到原来那台（休眠的沙箱在那里）；它不在了再挑别的。
      const previous = this.#states.get((await this.#hostOf(command.sessionId)) ?? "");
      const state = previous && this.#canTake(previous) ? previous : this.#pick();
      if (!state) {
        // 派出去之前宿主机正好全断了：照沙箱准备失败处理，管理员再发消息时重新排队。
        await this.#onEvent?.({
          type: "sandbox.failed",
          sessionId: command.sessionId,
          error: { code: "sandbox_unavailable" },
        });
        return;
      }
      await this.#deps.db
        .update(sessions)
        .set({ hostId: state.id })
        .where(eq(sessions.id, command.sessionId));
      this.#sessionHost.set(command.sessionId, state.id);
    }
    const hostId = await this.#hostOf(command.sessionId);
    const state = hostId ? this.#states.get(hostId) : undefined;
    if (!state || state.revoked) {
      // 会话不在任何一台宿主机上（还没派过，或者宿主机被吊销、删掉了）：没有地方可发。
      return;
    }
    const frame = state.peer.send(command);
    // 断线中的先记在补发队列里，重连以后发。
    if (state.connection) this.#write(state, { seq: frame.seq, ack: frame.ack, command });
  }

  #canTake(state: HostState): boolean {
    return !state.revoked && state.connection !== undefined && state.connection.protocol !== null;
  }

  /** 挑一台能接新会话的宿主机：名下会话最少的那台。 */
  #pick(): HostState | undefined {
    const load = new Map<string, number>();
    for (const hostId of this.#sessionHost.values()) load.set(hostId, (load.get(hostId) ?? 0) + 1);
    return [...this.#states.values()]
      .filter((s) => this.#canTake(s))
      .sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0];
  }

  #write(state: HostState, frame: object): void {
    const socket = state.connection?.socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    // 每一帧都带着 ack，单独的确认就不用发了。
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = undefined;
    socket.send(JSON.stringify(frame));
  }

  #scheduleAck(state: HostState): void {
    if (state.ackTimer || !state.connection) return;
    state.ackTimer = setTimeout(() => {
      state.ackTimer = undefined;
      this.#write(state, { ack: state.peer.received });
    }, ACK_DELAY_MS);
  }

  // ---- 凭据 ----

  #issueCredential(state: HostState): HostCredential {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.#deps.clock.now().getTime() + CREDENTIAL_TTL_MS;
    this.#credentials.set(token, { hostId: state.id, expiresAt });
    state.credentialExpiresAt = expiresAt;
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** 连着的宿主机的凭据还剩不到一半有效期时换一张新的；过期的清掉。旧的到期前照样能用。 */
  #renewCredentials(): void {
    const now = this.#deps.clock.now().getTime();
    for (const [token, entry] of this.#credentials) {
      if (entry.expiresAt <= now) this.#credentials.delete(token);
    }
    for (const state of this.#states.values()) {
      if (!state.connection || state.revoked) continue;
      if ((state.credentialExpiresAt ?? 0) - now > CREDENTIAL_TTL_MS / 2) continue;
      this.#write(state, { ack: state.peer.received, credential: this.#issueCredential(state) });
    }
  }

  #state(id: string, name: string, instance: string | null): HostState {
    let state = this.#states.get(id);
    if (!state) {
      state = {
        id,
        name,
        instance,
        peer: new LinkPeer<HostCommand>({ maxPending: MAX_PENDING }),
        offlineSince: this.#deps.clock.now(),
        revoked: false,
        chain: Promise.resolve(),
      };
      this.#states.set(id, state);
    }
    return state;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
