import type { HostEvent } from "@seekcloud/protocol";
import type { GitSessions } from "../git-proxy/sessions";
import { type SandboxGit, sandboxGitEnv, WORKSPACE, workspaceDirs } from "../sandbox/provision";
import type { Sandboxes } from "../sandbox/sandboxes";
import { DshAgent, type TurnInput } from "./dsh-agent";
import { branchDiffs, finishTurn, type SandboxExec, turnStart } from "./turn-end";

/** 守护进程处理主站的命令时用到的 Agent 操作（commands.ts）。测试里可以换成假的。 */
export interface AgentHost {
  startTurn(sessionId: string, input: TurnInput): Promise<void>;
  inject(sessionId: string, turnId: string, text: string): Promise<void>;
  stopTurn(sessionId: string, turnId: string): Promise<void>;
  /** 不再用这个会话的 Agent（删除沙箱）：断开它的运行器。 */
  close(sessionId: string): void;
}

/** 通用镜像里的路径（apps/host/sandbox/image/Dockerfile）。 */
const IMAGE = {
  node: "/opt/seekcloud/node/bin/node",
  runner: "/usr/local/lib/seekcloud/seekcloud-runner.mjs",
  dsh: "/usr/local/bin/dsh",
  baseline: "/usr/local/share/seekcloud/dsh/baseline.patch.yml",
  /** dsh 的数据（会话日志）：固定在沙箱里，休眠再启动以后还在。 */
  dshHome: "/root/.seekcloud/dsh",
  /** dsh 的启动目录：不放在仓库里。 */
  cwd: "/root",
};

/**
 * 每个会话一个 DshAgent（#25），经 docker exec 连沙箱里的运行器。dsh 调模型、联网工具都发到宿主机本地的
 * 模型网关转发（和 Git 代理同一个端口，apps/host/sandbox/README.md 的"模型网关"），API key 是会话临时令牌。
 * 沙箱就是安全边界（ADR 0005），dsh 里不再要批准（danger-full-access），照 Claude Code 网页版。
 */
export class SandboxAgents implements AgentHost {
  readonly #agents = new Map<string, DshAgent>();
  /** 正在跑的回合：开始时各仓库会话分支的提交（回合结束时算改了哪些文件）。 */
  readonly #turns = new Map<
    string,
    { turnId: string; starts: Map<string, string>; turnNumber?: number }
  >();
  /** 每个会话的事件按顺序交给主站：回合结束要先整理完工作区，turn.ended 才发出去。 */
  readonly #emitting = new Map<string, Promise<void>>();

  constructor(
    readonly deps: {
      sandboxes: Sandboxes;
      sessions: GitSessions;
      /** 沙箱连宿主机服务的地址（网桥上的 Git 代理，模型网关也在这个端口）、代理的 CA、签名公钥。 */
      git: SandboxGit;
      emit: (event: HostEvent) => void;
      log?: (message: string) => void;
    },
  ) {}

  async startTurn(sessionId: string, input: TurnInput): Promise<void> {
    const token = this.deps.sessions.get(sessionId)?.sessionToken;
    if (!token) {
      // 会话的登记信息只在内存里：守护进程重启过、主站还没重发（#111）
      this.deps.log?.(`会话 ${sessionId} 没有登记（守护进程重启过？），回合开始不了`);
      this.deps.emit({
        type: "agent",
        sessionId,
        turnId: input.turnId,
        event: { type: "turn.started" },
      });
      this.deps.emit({
        type: "agent",
        sessionId,
        turnId: input.turnId,
        event: { type: "turn.ended", reason: "failed", error: { code: "internal" } },
      });
      return;
    }
    const repos = this.deps.sessions.get(sessionId)?.workspace ?? [];
    const starts =
      repos.length > 0
        ? await turnStart(this.#exec(sessionId), repos).catch((error) => {
            this.deps.log?.(`会话 ${sessionId} 读不到回合开始时的提交：${String(error)}`);
            return new Map<string, string>();
          })
        : new Map<string, string>();
    this.#turns.set(sessionId, { turnId: input.turnId, starts, turnNumber: input.turnNumber });
    await this.#agent(sessionId).startTurn(input);
  }

  #exec(sessionId: string): SandboxExec {
    return (argv, options) => this.deps.sandboxes.exec(sessionId, argv, { ...options, user: "0" });
  }

  /** Agent 的事件：回合结束时先整理工作区（补提交、推送、改了哪些文件），发 workspace，再发 turn.ended。 */
  #emit(sessionId: string, event: HostEvent): void {
    const previous = this.#emitting.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const turn = this.#turns.get(sessionId);
        if (
          event.type === "agent" &&
          event.event.type === "turn.ended" &&
          turn?.turnId === event.turnId
        ) {
          this.#turns.delete(sessionId);
          const repos = this.deps.sessions.get(sessionId)?.workspace ?? [];
          if (repos.length > 0) {
            try {
              const outcomes = await finishTurn(this.#exec(sessionId), this.deps.git, {
                repos,
                starts: turn.starts,
                turnNumber: turn.turnNumber,
              });
              this.deps.emit({
                type: "agent",
                sessionId,
                turnId: event.turnId,
                event: { type: "workspace", repos: outcomes },
              });
            } catch (error) {
              this.deps.log?.(`会话 ${sessionId} 回合结束时整理工作区失败：${String(error)}`);
            }
          }
        }
        this.deps.emit(event);
        // 回合结束以后再算对比基础分支的 diff（改动面板），不耽误回合结束
        const repos = this.deps.sessions.get(sessionId)?.workspace ?? [];
        if (event.type === "agent" && event.event.type === "turn.ended" && repos.length > 0) {
          try {
            const diffs = await branchDiffs(this.#exec(sessionId), repos);
            this.deps.emit({
              type: "workspace.diff",
              sessionId,
              turnId: event.turnId,
              repos: diffs,
            });
          } catch (error) {
            this.deps.log?.(`会话 ${sessionId} 算改动的 diff 失败：${String(error)}`);
          }
        }
      })
      .catch((error) => this.deps.log?.(`会话 ${sessionId} 的事件没发出去：${String(error)}`));
    this.#emitting.set(sessionId, next);
    void next.then(() => {
      if (this.#emitting.get(sessionId) === next) this.#emitting.delete(sessionId);
    });
  }

  inject(sessionId: string, turnId: string, text: string): Promise<void> {
    return this.#agents.get(sessionId)?.inject(turnId, text) ?? Promise.resolve();
  }

  stopTurn(sessionId: string, turnId: string): Promise<void> {
    return this.#agents.get(sessionId)?.stopTurn(turnId) ?? Promise.resolve();
  }

  close(sessionId: string): void {
    this.#agents.get(sessionId)?.close();
    this.#agents.delete(sessionId);
    this.#turns.delete(sessionId);
  }

  #agent(sessionId: string): DshAgent {
    const existing = this.#agents.get(sessionId);
    if (existing) return existing;
    const { sandboxes, sessions, git } = this.deps;
    const agent = new DshAgent({
      sessionId,
      bridge: () => [
        "docker",
        "exec",
        "--interactive",
        sandboxes.containerName(sessionId),
        IMAGE.node,
        IMAGE.runner,
        "connect",
      ],
      launch: () => {
        const session = sessions.get(sessionId);
        const token = session?.sessionToken ?? "";
        return {
          args: [IMAGE.dsh, "--profile", "sdk", "--patch", IMAGE.baseline],
          cwd: IMAGE.cwd,
          env: {
            // git 的钩子、代理的 CA（sandbox/provision.ts）；dsh 跑的命令都继承这些
            ...sandboxGitEnv(git),
            DSH_HOME: IMAGE.dshHome,
            DSH_TELEMETRY_MODE: "DISABLED",
            DSH_PERMISSION_MODE: "danger-full-access",
            DEEPSEEK_BASE_URL: `http://${git.proxy.host}:${git.proxy.port}`,
            DEEPSEEK_API_KEY: token,
          },
          // 主仓库（第一个仓库）；没有仓库的会话在 /workspace
          workingDirectory: workspaceDirs(session?.repos ?? [])[0] ?? WORKSPACE,
        };
      },
      protect: (pid) => sandboxes.protect(sessionId, pid),
      emit: (event) => this.#emit(sessionId, event),
      log: this.deps.log,
    });
    this.#agents.set(sessionId, agent);
    return agent;
  }
}
