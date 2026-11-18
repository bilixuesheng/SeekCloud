import { randomUUID } from "node:crypto";
import type { AiLabels } from "@seekcloud/protocol";
import { Docker, DockerError, isNotFound } from "./docker";

/** 容器上的标签：守护进程重启以后按它认出自己建的沙箱（#18 的边界情况），不靠进程里记的东西。 */
export const SANDBOX_LABEL = "cn.seekcloud.sandbox";
export const SESSION_LABEL = "cn.seekcloud.session";
/** 宿主机在沙箱里跑的命令都带着这个环境变量，超时时按它找到这个命令起的所有进程。 */
const EXEC_MARK = "SEEKCLOUD_EXEC_ID";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SandboxSpec {
  image: string;
  /** 正式环境是 sysbox-runc（ADR 0005）；本机测试可以用 runc。 */
  runtime: string;
  /** 沙箱专用的网络（network.ts）。 */
  network: string;
  /** CPU 上限（核数，可以是小数）。 */
  cpus: number;
  /** 内存上限，MB。不给交换分区：用满了就是用满了。 */
  memoryMb: number;
  /** 镜像自己不常驻时（测试用的 alpine）给一个常驻的命令。通用镜像不用给。 */
  command?: string[];
  /**
   * 标签 cn.seekcloud.sandbox 的值，也是容器名的前缀的一部分。正式环境用默认的 "default"；
   * 测试每次用一个新的，和宿主机上别的沙箱互不干扰。
   */
  pool?: string;
}

export type SandboxState = "running" | "stopped";

export interface SandboxInfo {
  sessionId: string;
  containerId: string;
  state: SandboxState;
}

export interface ExecOptions {
  /** 写进标准输入。不给时命令的标准输入是空的。 */
  input?: string;
  /** 到点以后杀掉这个命令起的所有进程。不给就不限时。 */
  timeoutMs?: number;
  /** 工作目录（沙箱里的路径）。 */
  cwd?: string;
  /** 用哪个用户跑，默认是镜像的默认用户。 */
  user?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  /** 退出码；超时被杀时为 null。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 守护进程处理主站的命令时用到的沙箱操作（commands.ts）。测试里可以换成假的。 */
export interface SandboxHost {
  /** 沙箱不在就建，停着就启动；写好 AI 标识的开关。 */
  prepare(sessionId: string, aiLabels: AiLabels): Promise<void>;
  /** 沙箱开着时把新的开关写进去；没开着时什么也不做，下次准备沙箱时再写。 */
  setAiLabels(sessionId: string, aiLabels: AiLabels): Promise<void>;
  /** 停掉并删除沙箱和它的文件。沙箱不在时什么也不做。 */
  destroy(sessionId: string): Promise<void>;
  /** 宿主机上现在有几个沙箱（开着的和停着的），上报负载用。 */
  count(): Promise<number>;
}

/**
 * 宿主机上的沙箱（#18、ADR 0005）：每个会话一个 Sysbox 系统容器，按会话 ID 认。
 *
 * 沙箱的容器不依赖守护进程这个进程：守护进程退出、重启，沙箱照常跑，里面的后台命令不停（#18 的 2026-11-15 评论）。
 * 守护进程重启以后靠容器上的标签认回来，不重复建。同一个会话的操作一个接一个做。
 */
export class Sandboxes implements SandboxHost {
  readonly #docker: Docker;
  readonly #spec: SandboxSpec;
  readonly #pool: string;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(spec: SandboxSpec, docker = new Docker()) {
    this.#spec = spec;
    this.#docker = docker;
    this.#pool = spec.pool ?? "default";
  }

  /** 容器名。会话 ID 不是 UUID 的一律不认（它会进 docker 的命令行）。 */
  containerName(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`会话 ID 不对：${sessionId}`);
    return this.#pool === "default"
      ? `seekcloud-${sessionId}`
      : `seekcloud-${this.#pool}-${sessionId}`;
  }

  /** 宿主机上这一组的所有沙箱。 */
  async list(): Promise<SandboxInfo[]> {
    const out = await this.#docker.ok([
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `label=${SANDBOX_LABEL}=${this.#pool}`,
      "--format",
      `{{.ID}}\t{{.Label "${SESSION_LABEL}"}}\t{{.State}}`,
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [containerId = "", sessionId = "", state = ""] = line.split("\t");
        return { containerId, sessionId, state: toState(state) };
      });
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }

  /** 这个会话的沙箱，不在时为 undefined。 */
  find(sessionId: string): Promise<SandboxInfo | undefined> {
    return this.#inspect(sessionId).then((c) => c && toInfo(sessionId, c));
  }

  /** 沙箱不在就建，停着就启动。返回开着的沙箱。 */
  ensure(sessionId: string): Promise<SandboxInfo> {
    return this.#serial(sessionId, async () => {
      const name = this.containerName(sessionId);
      let container = await this.#inspect(sessionId);
      if (!container) {
        await this.#docker.ok(this.#createArgs(sessionId));
        container = await this.#inspect(sessionId);
        if (!container) throw new Error(`沙箱 ${name} 建了以后找不到`);
      }
      switch (container.State.Status) {
        case "running":
        case "restarting":
          break;
        case "paused":
          await this.#docker.ok(["unpause", name]);
          break;
        case "created":
        case "exited":
          await this.#docker.ok(["start", name]);
          break;
        default:
          throw new Error(`沙箱 ${name} 的状态是 ${container.State.Status}，启动不了`);
      }
      return { sessionId, containerId: container.Id, state: "running" };
    });
  }

  /** 停下沙箱，文件留着（休眠）。沙箱不在时什么也不做。 */
  stop(sessionId: string): Promise<void> {
    return this.#serial(sessionId, async () => {
      const args = ["stop", "--timeout", "10", this.containerName(sessionId)];
      const result = await this.#docker.raw(args);
      if (result.code !== 0 && !isNotFound(result)) throw new DockerError(args, result);
    });
  }

  /** 删掉沙箱和它的文件（包括沙箱里 Docker 的镜像和卷）。沙箱不在时什么也不做。 */
  remove(sessionId: string): Promise<void> {
    return this.#serial(sessionId, async () => {
      const args = ["rm", "--force", "--volumes", this.containerName(sessionId)];
      const result = await this.#docker.raw(args);
      if (result.code !== 0 && !isNotFound(result)) throw new DockerError(args, result);
    });
  }

  /**
   * 在开着的沙箱里跑一个命令，拿到输出（给克隆仓库、启动 Agent 这些宿主机自己的操作用）。
   * argv 原样传给沙箱里的程序，不经过 shell。超时时杀掉这个命令起的所有进程（按 EXEC_MARK 找）。
   */
  async exec(
    sessionId: string,
    argv: readonly string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    if (argv.length === 0) throw new Error("没有要跑的命令");
    const name = this.containerName(sessionId);
    const container = await this.#inspect(sessionId);
    if (container?.State.Status !== "running") throw new Error(`沙箱 ${name} 没有开着`);
    const execId = randomUUID();
    const args = ["exec"];
    if (options.input !== undefined) args.push("--interactive");
    if (options.user) args.push("--user", options.user);
    if (options.cwd) args.push("--workdir", options.cwd);
    args.push("--env", `${EXEC_MARK}=${execId}`);
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!ENV_NAME.test(key)) throw new Error(`环境变量名不对：${key}`);
      args.push("--env", `${key}=${value}`);
    }
    args.push(name, ...argv);
    const result = await this.#docker.raw(args, {
      input: options.input,
      timeoutMs: options.timeoutMs,
    });
    if (result.timedOut) await this.#killExec(name, execId);
    return {
      exitCode: result.timedOut ? null : result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }

  /** 在沙箱里写一个文件（目录不在就建）。内容从标准输入进去，路径是一个单独的参数。 */
  async writeFile(sessionId: string, path: string, content: string): Promise<void> {
    const result = await this.exec(
      sessionId,
      ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
      { input: content, user: "0", timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`在沙箱里写 ${path} 失败：${result.stderr.trim()}`);
    }
  }

  // ---- SandboxHost ----

  async prepare(sessionId: string, aiLabels: AiLabels): Promise<void> {
    await this.ensure(sessionId);
    await this.#writeAiLabels(sessionId, aiLabels);
  }

  async setAiLabels(sessionId: string, aiLabels: AiLabels): Promise<void> {
    if ((await this.find(sessionId))?.state !== "running") return;
    await this.#writeAiLabels(sessionId, aiLabels);
  }

  destroy(sessionId: string): Promise<void> {
    return this.remove(sessionId);
  }

  // ---- 内部 ----

  /** 提交尾注的开关：沙箱里的 git 钩子每次提交都读它（apps/host/sandbox/README.md）。 */
  #writeAiLabels(sessionId: string, aiLabels: AiLabels): Promise<void> {
    return this.writeFile(
      sessionId,
      "/etc/seekcloud/commit-trailer",
      aiLabels.commitTrailer ? "on\n" : "off\n",
    );
  }

  #createArgs(sessionId: string): string[] {
    const spec = this.#spec;
    return [
      "create",
      "--name",
      this.containerName(sessionId),
      "--label",
      `${SANDBOX_LABEL}=${this.#pool}`,
      "--label",
      `${SESSION_LABEL}=${sessionId}`,
      "--runtime",
      spec.runtime,
      "--network",
      spec.network,
      "--hostname",
      "seekcloud",
      "--cpus",
      String(spec.cpus),
      "--memory",
      `${spec.memoryMb}m`,
      "--memory-swap",
      `${spec.memoryMb}m`,
      spec.image,
      ...(spec.command ?? []),
    ];
  }

  async #inspect(sessionId: string): Promise<Container | undefined> {
    const args = ["container", "inspect", "--format", "{{json .}}", this.containerName(sessionId)];
    const result = await this.#docker.raw(args);
    if (isNotFound(result)) return undefined;
    if (result.code !== 0) throw new DockerError(args, result);
    const container = JSON.parse(result.stdout) as Container;
    // 同名但不是我们建的（没有标签、或者标的是别的会话）：不碰它。
    const labels = container.Config.Labels ?? {};
    if (labels[SANDBOX_LABEL] !== this.#pool || labels[SESSION_LABEL] !== sessionId) {
      throw new Error(`容器 ${this.containerName(sessionId)} 不是 SeekCloud 建的沙箱，不碰它`);
    }
    return container;
  }

  /** 杀掉带着这个标记的所有进程：命令自己和它起的子进程，包括转到后台的。 */
  async #killExec(name: string, execId: string): Promise<void> {
    const script =
      'for d in /proc/[0-9]*; do tr "\\0" "\\n" < "$d/environ" 2>/dev/null | grep -qxF "$1" && kill -KILL "$(basename "$d")" 2>/dev/null; done; true';
    await this.#docker.raw(
      ["exec", "--user", "0", name, "sh", "-c", script, "sh", `${EXEC_MARK}=${execId}`],
      {
        timeoutMs: 30_000,
      },
    );
  }

  #serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => {});
    this.#queues.set(sessionId, settled);
    void settled.then(() => {
      if (this.#queues.get(sessionId) === settled) this.#queues.delete(sessionId);
    });
    return next;
  }
}

interface Container {
  Id: string;
  State: { Status: string };
  Config: { Labels: Record<string, string> | null };
  HostConfig?: { Memory?: number; NanoCpus?: number; Runtime?: string };
}

const toState = (status: string): SandboxState =>
  status === "running" || status === "restarting" ? "running" : "stopped";

const toInfo = (sessionId: string, c: Container): SandboxInfo => ({
  sessionId,
  containerId: c.Id,
  state: toState(c.State.Status),
});
