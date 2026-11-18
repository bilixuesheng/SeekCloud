import { randomBytes } from "node:crypto";
import type { HostCommand, HostEvent } from "@seekcloud/protocol";
import type { GitSessions } from "../git-proxy/sessions";

/**
 * 主站发来的命令怎么处理（#91）。仓库、GitHub 令牌、AI 标识的开关登记进 Git 代理的会话表；
 * 沙箱还没有（Sysbox 沙箱在 #18 里做）：准备沙箱照"建不了沙箱"回，回合照失败结束。
 * 不认识的命令（主站比宿主机新）记一笔、当作不支持（PROTOCOL_VERSION 的规矩）。
 */
export function handleCommands(deps: {
  sessions: GitSessions;
  send: (event: HostEvent) => void;
  log?: (message: string) => void;
}): (command: HostCommand) => Promise<void> {
  const log = deps.log ?? ((message) => console.log(message));
  return async (command) => {
    switch (command.type) {
      case "prepare_sandbox":
        deps.sessions.register({
          sessionId: command.sessionId,
          // 会话临时令牌：沙箱用它向 Git 代理表明身份（ADR 0003）。沙箱停止时作废。
          sessionToken: randomBytes(32).toString("base64url"),
          repos: command.repos.map((r) => ({ fullName: r.fullName, access: r.access })),
          aiLabels: command.aiLabels,
        });
        deps.send({
          type: "sandbox.failed",
          sessionId: command.sessionId,
          error: { code: "sandbox_unavailable" },
        });
        return;
      case "set_github_token":
        deps.sessions.setGitHubToken(command.sessionId, command.token);
        return;
      case "set_ai_labels":
        deps.sessions.setAiLabels(command.sessionId, command.aiLabels);
        return;
      case "destroy_sandbox":
        deps.sessions.remove(command.sessionId);
        return;
      case "start_turn":
        deps.send({
          type: "agent",
          sessionId: command.sessionId,
          turnId: command.turnId,
          event: { type: "turn.ended", reason: "failed", error: { code: "sandbox_unavailable" } },
        });
        return;
      case "inject_message":
      case "stop_turn":
        // 没有在跑的回合，没什么可插、可停的。
        return;
      default:
        log(
          `主站发来不认识的命令 ${(command as { type: string }).type}（主站可能比宿主机新），已忽略`,
        );
    }
  };
}
