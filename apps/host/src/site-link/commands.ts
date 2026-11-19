import { randomBytes } from "node:crypto";
import type { HostCommand, HostEvent } from "@seekcloud/protocol";
import type { AgentHost } from "../agent/sandbox-agents";
import type { GitSessions } from "../git-proxy/sessions";
import { CloneError, type SandboxGit } from "../sandbox/provision";
import type { SandboxHost } from "../sandbox/sandboxes";

/**
 * 主站发来的命令怎么处理（#91、#18）。仓库、GitHub 令牌、AI 标识的开关登记进 Git 代理的会话表；
 * 有沙箱时（配了沙箱镜像，见 main.ts）准备沙箱就建、启动沙箱，回"沙箱好了"，建不了回"建不了沙箱"并带参考号，
 * 原始报错只写进宿主机的日志（ADR 0007）。没有沙箱时一律回"建不了沙箱"。
 * 准备沙箱时顺带配好工作区（#27，sandbox/provision.ts）：装代理的 CA、写 git 配置、克隆仓库、切到会话分支；
 * 克隆失败回"克隆仓库失败"。
 * 回合交给 Agent（#25，沙箱里的 dsh）：开始、插话、停止。没有 Agent 时回合照失败结束。
 * 不认识的命令（主站比宿主机新）记一笔、当作不支持（PROTOCOL_VERSION 的规矩）。
 *
 * 沙箱的操作可能要几分钟（第一次要拉镜像），不挡着别的会话的命令：每个会话的沙箱操作排成一队在后台做，
 * 同一个会话的按主站发来的顺序做。
 */
export function handleCommands(deps: {
  sessions: GitSessions;
  send: (event: HostEvent) => void;
  sandboxes?: SandboxHost;
  /** 沙箱里的 git 怎么连 Git 代理；不给就不配工作区（只建沙箱）。 */
  git?: SandboxGit;
  agents?: AgentHost;
  log?: (message: string) => void;
  /** 克隆之前等 GitHub 令牌下发的最长时间（主站紧跟着准备沙箱发）。 */
  tokenWaitMs?: number;
}): (command: HostCommand) => Promise<void> {
  const log = deps.log ?? ((message) => console.log(message));
  const queues = new Map<string, Promise<void>>();

  /** 排进这个会话的队列；出错时记日志、按 onError 回主站。 */
  const inOrder = (
    sessionId: string,
    what: string,
    work: () => Promise<void>,
    onError?: (ref: string, error: unknown) => void,
  ) => {
    const next = (queues.get(sessionId) ?? Promise.resolve()).then(work).catch((error) => {
      const ref = randomBytes(4).toString("hex");
      log(
        `[${ref}] 会话 ${sessionId} ${what}失败：${error instanceof Error ? error.message : String(error)}`,
      );
      onError?.(ref, error);
    });
    queues.set(sessionId, next);
    void next.then(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
  };

  /** 克隆要用 GitHub 令牌：等它下发（一般紧跟着就到），等不到也照样克隆，失败了报出来。 */
  const waitForToken = async (sessionId: string) => {
    const deadline = Date.now() + (deps.tokenWaitMs ?? 30_000);
    while (!deps.sessions.get(sessionId)?.githubToken && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  return async (command) => {
    switch (command.type) {
      case "prepare_sandbox": {
        const { sessionId, aiLabels } = command;
        // 会话临时令牌：沙箱用它向 Git 代理表明身份（ADR 0003）。沙箱停止时作废。
        const sessionToken = randomBytes(32).toString("base64url");
        deps.sessions.register({
          sessionId,
          sessionToken,
          repos: command.repos.map((r) => ({ fullName: r.fullName, access: r.access })),
          workspace: command.repos,
          aiLabels,
          committer: command.committer,
        });
        const sandboxes = deps.sandboxes;
        if (!sandboxes) {
          deps.send({ type: "sandbox.failed", sessionId, error: { code: "sandbox_unavailable" } });
          return;
        }
        inOrder(
          sessionId,
          "准备沙箱",
          async () => {
            const git = deps.git;
            if (git && command.repos.length > 0) await waitForToken(sessionId);
            await sandboxes.prepare(
              sessionId,
              aiLabels,
              git && {
                git,
                setup: { sessionToken, committer: command.committer, repos: command.repos },
              },
            );
            // 沙箱被回收过：放回 Agent 的会话文件。放不回去不挡着，开始回合时接不上会话再报
            if (command.agentArchive && deps.agents?.restore) {
              await deps.agents
                .restore(sessionId, command.agentArchive)
                .catch((error) => log(`会话 ${sessionId} ${String(error)}`));
            }
            deps.send({ type: "sandbox.ready", sessionId });
          },
          (ref, error) =>
            deps.send({
              type: "sandbox.failed",
              sessionId,
              error: {
                code: error instanceof CloneError ? "repo_clone_failed" : "sandbox_unavailable",
                ref,
              },
            }),
        );
        return;
      }
      case "set_github_token":
        deps.sessions.setGitHubToken(command.sessionId, command.token);
        return;
      case "set_ai_labels": {
        const { sessionId, aiLabels } = command;
        deps.sessions.setAiLabels(sessionId, aiLabels);
        const sandboxes = deps.sandboxes;
        if (sandboxes) {
          inOrder(sessionId, "改 AI 标识的开关", () => sandboxes.setAiLabels(sessionId, aiLabels));
        }
        return;
      }
      case "destroy_sandbox": {
        const { sessionId } = command;
        deps.sessions.remove(sessionId);
        deps.agents?.close(sessionId);
        const sandboxes = deps.sandboxes;
        if (sandboxes) inOrder(sessionId, "删除沙箱", () => sandboxes.destroy(sessionId));
        return;
      }
      case "start_turn": {
        const agents = deps.agents;
        if (agents) {
          const { sessionId, turnId, text, model, effort } = command;
          inOrder(sessionId, "开始回合", () =>
            agents.startTurn(sessionId, {
              turnId,
              text,
              model,
              effort,
              firstTurn: command.firstTurn ?? false,
              turnNumber: command.turnNumber,
            }),
          );
          return;
        }
        deps.send({
          type: "agent",
          sessionId: command.sessionId,
          turnId: command.turnId,
          event: {
            type: "turn.ended",
            reason: "failed",
            error: { code: deps.sandboxes ? "internal" : "sandbox_unavailable" },
          },
        });
        return;
      }
      case "inject_message": {
        const agents = deps.agents;
        // 插话不排队：Agent 正在跑回合，排在 start_turn 后面就等到回合结束了
        if (agents)
          void agents
            .inject(command.sessionId, command.turnId, command.text)
            .catch((e) => log(String(e)));
        return;
      }
      case "stop_turn": {
        const agents = deps.agents;
        if (agents)
          void agents.stopTurn(command.sessionId, command.turnId).catch((e) => log(String(e)));
        return;
      }
      default:
        log(
          `主站发来不认识的命令 ${(command as { type: string }).type}（主站可能比宿主机新），已忽略`,
        );
    }
  };
}
