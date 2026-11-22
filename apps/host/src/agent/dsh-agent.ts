import { randomBytes } from "node:crypto";
import type { HostEvent, SafeError, ThinkingEffort } from "@seekcloud/protocol";
import { DshEventMapper } from "./dsh-events";
import { type RunnerEntry, RunnerLink } from "./runner-link";

/** 没说用哪个路由时（旧版本的主站）：DeepSeek 官方，模型 ID 和 dsh 官方目录里的一样。 */
const PROVIDER = "deepseek-official";

/** 怎么在沙箱里起 dsh（由调用方按沙箱算好）。 */
export interface DshLaunch {
  /** dsh 的命令行：可执行文件、--profile sdk、--patch 基线配置…… */
  args: string[];
  /** dsh 的启动目录：不放在仓库里（仓库的 .env 里写了代理变量时 dsh 会拒绝启动）。 */
  cwd: string;
  env: Record<string, string>;
  /** Agent 的工作目录：主仓库。会话第一次起 dsh 时用 session/working-directory/set 指过去。 */
  workingDirectory: string;
}

export interface DshAgentOptions {
  sessionId: string;
  /** 连运行器的命令（沙箱里是 docker exec -i …；测试里是本机进程）。 */
  bridge: () => string[];
  launch: () => DshLaunch;
  emit: (event: HostEvent) => void;
  /** dsh 起来以后把它设成内存用满时不杀（Sandboxes.protect）；测试里不用。 */
  protect?: (pid: number) => Promise<void>;
  log?: (message: string) => void;
  /** 等 dsh 回一个请求最多等多久。 */
  requestTimeoutMs?: number;
  /** 开始回合时等运行器打招呼最多等多久（默认 30 秒）。 */
  connectTimeoutMs?: number;
}

/** dsh 进程用的路由：initialize 是整个进程的，这几样变了要重启 dsh。 */
interface Route {
  provider: string;
  model: string;
  effort: ThinkingEffort | undefined;
  config: string;
}

export interface TurnInput {
  turnId: string;
  text: string;
  model: string;
  effort: ThinkingEffort;
  /** dsh 里的路由名（#188）：DeepSeek 是 deepseek-official，别的提供方是 Provider ID。不填是 DeepSeek。 */
  provider?: string;
  /** 为假时不带思考强度（模型没声明推理等级）。不填是带。 */
  reasoning?: boolean;
  /** 模型配置的版本（agent/models-config.ts）：变了要重启 dsh 才读得到新的配置。 */
  config?: string;
  /** 会话的第一个回合：dsh 那边还没有这个会话，不用 resume。 */
  firstTurn: boolean;
  /** 会话的第几个回合，回合结束时补提交的说明里用（agent/turn-end.ts）。 */
  turnNumber?: number;
}

/** 内部错误：原始报错只记宿主机日志，给平台的只有类别和参考号（ADR 0007）。 */
class AgentFailure extends Error {
  constructor(
    readonly safe: SafeError,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 一个会话的 Agent（#25 的 dsh 实现）：经运行器在沙箱里托管 dsh 进程，用 SDK（JSON-RPC）驱动它，
 * 把它的事件转成平台的事件（dsh-events.ts）。
 *
 * - 开始回合：dsh 没在跑就起，先 initialize，不是第一个回合就 session/resume（被拒就失败，不悄悄开新会话），
 *   再 session/prompt。换了模型或思考强度就重启 dsh（initialize 是整个进程的）。
 * - 插话：Agent 在跑时再发一次 session/prompt，dsh 放进收件箱，读到以后接着跑。
 * - 停止：SDK 没有停止回合的方法，停掉 dsh 进程，下次发消息时重启、resume。
 * - dsh 意外退出：回合以"内部错误"失败（带参考号）。
 */
export class DshAgent {
  readonly #options: DshAgentOptions;
  readonly #mapper: DshEventMapper;
  readonly #link: RunnerLink;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** 运行器那边 dsh 在不在跑、跑的是哪个模型（我们起的才知道；守护进程重启后认回来的不知道）。 */
  #running = false;
  #route: Route | undefined;
  #initialized = false;
  #starting: { resolve: (pid: number) => void; reject: (e: Error) => void } | undefined;
  #exited: (() => void)[] = [];
  #stopping = false;
  #welcomed: Promise<void>;
  #welcome: () => void = () => {};

  constructor(options: DshAgentOptions) {
    this.#options = options;
    this.#mapper = new DshEventMapper(options.sessionId, options.emit);
    this.#welcomed = new Promise((resolve) => {
      this.#welcome = resolve;
    });
    this.#link = new RunnerLink({
      bridge: options.bridge,
      log: options.log,
      onWelcome: (welcome, changed) => {
        if (changed || !welcome.running) this.#forgetProcess();
        else this.#running = true;
        this.#welcome();
      },
      onEntry: (entry) => this.#onEntry(entry),
    });
    this.#link.start();
  }

  get turnId(): string | undefined {
    return this.#mapper.turnId;
  }

  /** 开始一个回合。出错时回合以失败结束（不抛给调用方）。 */
  async startTurn(input: TurnInput): Promise<void> {
    this.#mapper.beginTurn(input.turnId);
    try {
      await this.#untilWelcomed();
      await this.#ensureDsh(input);
      await this.#request("session/prompt", {
        sessionId: this.#options.sessionId,
        contentBlocks: [{ type: "text", text: input.text }],
      });
    } catch (error) {
      this.#fail(error, "开始回合");
    }
  }

  /** 回合进行中插话。没有在跑的回合时什么也不做（消息照样记在会话里）。 */
  async inject(turnId: string, text: string): Promise<void> {
    if (this.#mapper.turnId !== turnId || !this.#running || !this.#initialized) return;
    try {
      await this.#request("session/prompt", {
        sessionId: this.#options.sessionId,
        contentBlocks: [{ type: "text", text }],
      });
    } catch (error) {
      this.#options.log?.(`会话 ${this.#options.sessionId} 插话失败：${String(error)}`);
    }
  }

  /** 停下这个回合：停掉 dsh 进程（不停后台命令以外的办法 SDK 没有）。 */
  async stopTurn(turnId: string): Promise<void> {
    if (this.#mapper.turnId !== turnId) return;
    this.#mapper.endTurn("stopped");
    await this.#stopDsh();
  }

  /** 不再用这个会话（删除沙箱、守护进程退出）：断开运行器（dsh 由沙箱一起处理）。 */
  close(): void {
    this.#link.stop();
    for (const p of this.#pending.values()) p.reject(new Error("连接已关闭"));
    this.#pending.clear();
  }

  // ---- 内部 ----

  /** 等运行器打完招呼。运行器没了（沙箱里的进程被杀、连不上）时不一直等：到时间回合以内部错误失败。 */
  async #untilWelcomed(): Promise<void> {
    const timeoutMs = this.#options.connectTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`连不上沙箱里的运行器（等了 ${timeoutMs} 毫秒）`)),
        timeoutMs,
      );
      timer.unref();
    });
    try {
      await Promise.race([this.#welcomed, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #ensureDsh(input: TurnInput): Promise<void> {
    const route: Route = {
      provider: input.provider ?? PROVIDER,
      model: input.model,
      effort: input.reasoning === false ? undefined : input.effort,
      config: input.config ?? "",
    };
    if (this.#running && this.#initialized && this.#route && !sameRoute(this.#route, route)) {
      // 换了模型或思考强度：initialize 是整个进程的，重启 dsh
      await this.#stopDsh();
    }
    if (this.#running && this.#initialized) return;
    // 守护进程重启后认回来的 dsh：不知道它 initialize 过没有、用的哪个模型，重启一个干净的再 resume。
    // （回合进行中守护进程重启、不打断回合接着收事件，跟着一键更新做，#111）
    if (this.#running && !this.#initialized) await this.#stopDsh();
    await this.#startDsh();
    await this.#request("initialize", {
      cwd: this.#options.launch().workingDirectory,
      provider: route.provider,
      model: input.model,
      ...(route.effort ? { reasoningEffort: route.effort } : {}),
      approvalRequests: false,
    });
    this.#route = route;
    if (!input.firstTurn) {
      try {
        await this.#request("session/resume", { sessionId: this.#options.sessionId });
      } catch (error) {
        throw new AgentFailure(
          { code: "internal" },
          `dsh 读不回这个会话（session/resume 被拒）：${String(error)}`,
        );
      }
    } else {
      await this.#request("session/working-directory/set", {
        sessionId: this.#options.sessionId,
        path: this.#options.launch().workingDirectory,
      });
    }
    this.#initialized = true;
  }

  #startDsh(): Promise<void> {
    const launch = this.#options.launch();
    const started = new Promise<number>((resolve, reject) => {
      // 运行器没回"起来了"也没回错误（比如连接断了又没连上）：不一直等下去
      const timer = setTimeout(() => {
        this.#starting = undefined;
        reject(new Error("等不到 dsh 起来（30 秒）"));
      }, 30_000);
      timer.unref();
      this.#starting = {
        resolve: (pid) => {
          clearTimeout(timer);
          resolve(pid);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
    this.#link.send({ op: "start", args: launch.args, cwd: launch.cwd, env: launch.env });
    return started.then(async (pid) => {
      this.#running = true;
      await this.#options
        .protect?.(pid)
        .catch((error) => this.#options.log?.(`没能把 dsh 设成内存用满时不杀：${String(error)}`));
    });
  }

  async #stopDsh(): Promise<void> {
    if (!this.#running) return;
    this.#stopping = true;
    const exited = new Promise<void>((resolve) => this.#exited.push(resolve));
    this.#link.send({ op: "stop", graceMs: 3000 });
    // 运行器 3 秒后会 SIGKILL；再等不到退出（连接断了）就当它没了，下次起一个新的
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.#options.log?.(`会话 ${this.#options.sessionId} 等不到 dsh 退出，当作已经停了`);
        this.#stopping = false;
        this.#forgetProcess();
        resolve();
      }, 10_000);
      timer.unref();
    });
    await Promise.race([exited, late]);
    clearTimeout(timer);
  }

  #forgetProcess(): void {
    this.#running = false;
    this.#initialized = false;
    this.#route = undefined;
    for (const p of this.#pending.values()) p.reject(new Error("dsh 已经退出"));
    this.#pending.clear();
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const timeoutMs = this.#options.requestTimeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`dsh 没有回 ${method}（等了 ${timeoutMs} 毫秒）`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#link.send({ op: "send", line: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    });
  }

  #onEntry(entry: RunnerEntry): void {
    switch (entry.type) {
      case "rpc":
        this.#onRpc(entry.line);
        return;
      case "live":
        this.#mapper.onLive(entry.line);
        return;
      case "started":
        this.#starting?.resolve(entry.pid);
        this.#starting = undefined;
        return;
      case "stderr":
        this.#options.log?.(`dsh（${this.#options.sessionId}）：${entry.text}`);
        return;
      case "error":
        this.#starting?.reject(new Error(entry.text));
        this.#starting = undefined;
        this.#options.log?.(`运行器（${this.#options.sessionId}）：${entry.text}`);
        return;
      case "exit": {
        const expected = this.#stopping;
        this.#stopping = false;
        this.#forgetProcess();
        this.#starting?.reject(new Error(`dsh 起来就退出了（退出码 ${entry.code}）`));
        this.#starting = undefined;
        for (const done of this.#exited.splice(0)) done();
        if (!expected && this.#mapper.turnId) {
          this.#fail(
            new AgentFailure(
              { code: "internal" },
              `dsh 意外退出（退出码 ${entry.code}，信号 ${entry.signal}）`,
            ),
            "跑回合",
          );
        }
        return;
      }
    }
  }

  #onRpc(line: string): void {
    let frame: {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame.method === "string") {
      if (frame.id !== undefined) {
        // dsh 问我们（选择题、批准）：平台的卡片还没接上，先回不支持，dsh 照它的规矩处理
        this.#link.send({
          op: "send",
          line: JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32601, message: "not supported" },
          }),
        });
        return;
      }
      this.#mapper.onNotification(frame.method, frame.params);
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.#pending.get(frame.id);
    if (!pending) return; // 守护进程重启前发的请求的回复
    this.#pending.delete(frame.id);
    if (frame.error) pending.reject(new Error(JSON.stringify(frame.error)));
    else pending.resolve(frame.result);
  }

  #fail(error: unknown, what: string): void {
    const ref = randomBytes(4).toString("hex");
    const safe = error instanceof AgentFailure ? error.safe : { code: "internal" as const };
    this.#options.log?.(
      `[${ref}] 会话 ${this.#options.sessionId} ${what}失败：${error instanceof Error ? error.message : String(error)}`,
    );
    this.#mapper.endTurn("failed", { ...safe, ref });
  }
}

const sameRoute = (a: Route, b: Route) =>
  a.provider === b.provider &&
  a.model === b.model &&
  a.effort === b.effort &&
  a.config === b.config;
