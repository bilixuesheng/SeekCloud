import { randomBytes } from "node:crypto";
import type { HostCommand, HostEvent } from "@seekcloud/protocol";
import type { AgentHost } from "../agent/sandbox-agents";
import type { GitSessions } from "../git-proxy/sessions";
import type { SandboxHost } from "../sandbox/sandboxes";

/**
 * 主站发来的命令怎么处理（#91、#18）。仓库、GitHub 令牌、AI 标识的开关登记进 Git 代理的会话表；
 * 有沙箱时（配了沙箱镜像，见 main.ts）准备沙箱就建、启动沙箱，回"沙箱好了"，建不了回"建不了沙箱"并带参考号，
 * 原始报错只写进宿主机的日志（ADR 0007）。没有沙箱时一律回"建不了沙箱"。
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
  agents?: AgentHost;
  log?: (message: string) => void;
}): (command: HostCommand) => Promise<void> {
  const log = deps.log ?? ((message) => console.log(message));
  const queues = new Map<string, Promise<void>>();

  /** 排进这个会话的队列；出错时记日志、按 onError 回主站。 */
  const inOrder = (
    sessionId: string,
    what: string,
    work: () => Promise<void>,
    onError?: (ref: string) => void,
  ) => {
    const next = (queues.get(sessionId) ?? Promise.resolve()).then(work).catch((error) => {
      const ref = randomBytes(4).toString("hex");
      log(
        `[${ref}] 会话 ${sessionId} ${what}失败：${error instanceof Error ? error.message : String(error)}`,
      );
      onError?.(ref);
    });
    queues.set(sessionId, next);
    void next.then(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
  };

  return async (command) => {
    switch (command.type) {
      case "prepare_sandbox": {
        const { sessionId, aiLabels } = command;
        deps.sessions.register({
          sessionId,
          // 会话临时令牌：沙箱用它向 Git 代理表明身份（ADR 0003）。沙箱停止时作废。
          sessionToken: randomBytes(32).toString("base64url"),
          repos: command.repos.map((r) => ({ fullName: r.fullName, access: r.access })),
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
            await sandboxes.prepare(sessionId, aiLabels);
            deps.send({ type: "sandbox.ready", sessionId });
          },
          (ref) =>
            deps.send({
              type: "sandbox.failed",
              sessionId,
              error: { code: "sandbox_unavailable", ref },
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
