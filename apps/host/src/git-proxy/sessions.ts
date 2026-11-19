import type { AiLabels, Committer, SessionRepo } from "@seekcloud/protocol";
import type { MountedRepo } from "./rules";

export interface GitSession {
  sessionId: string;
  /** 会话临时令牌：沙箱用它向代理表明身份。沙箱停止时作废。 */
  sessionToken: string;
  repos: MountedRepo[];
  /** 用户的 GitHub 访问令牌，主站下发，只放在内存里。 */
  githubToken?: string;
  /** AI 标识的两个开关，主站下发。没下发过时按都开处理。 */
  aiLabels?: AiLabels;
  /** 提交身份（管理员关联的 GitHub 账号），主站下发（#27）。签名服务只签提交者是它的提交。 */
  committer?: Committer;
  /** 仓库的完整信息（基础分支、会话分支）：回合开始、结束时整理工作区用（agent/turn-end.ts）。 */
  workspace?: SessionRepo[];
}

/** 正在运行的会话。全部在内存里：宿主机重启后由主站重新下发。 */
export class GitSessions {
  readonly #byId = new Map<string, GitSession>();
  readonly #byToken = new Map<string, GitSession>();

  /** 登记或更新（比如中途挂载了仓库）。已经下发的 GitHub 令牌保留；这次没带 AI 标识的开关时，原来的也保留。 */
  register(session: Omit<GitSession, "githubToken">): void {
    const old = this.#byId.get(session.sessionId);
    this.remove(session.sessionId);
    const entry: GitSession = {
      ...session,
      githubToken: old?.githubToken,
      aiLabels: session.aiLabels ?? old?.aiLabels,
    };
    this.#byId.set(entry.sessionId, entry);
    this.#byToken.set(entry.sessionToken, entry);
  }

  /** 主站下发或刷新用户的 GitHub 令牌。 */
  setGitHubToken(sessionId: string, token: string): void {
    const session = this.#byId.get(sessionId);
    if (session) session.githubToken = token;
  }

  /** 主站下发或更新 AI 标识的开关：运行中的会话下一次写 GitHub 时就按新的来。 */
  setAiLabels(sessionId: string, aiLabels: AiLabels): void {
    const session = this.#byId.get(sessionId);
    if (session) session.aiLabels = aiLabels;
  }

  remove(sessionId: string): void {
    const session = this.#byId.get(sessionId);
    if (!session) return;
    this.#byId.delete(sessionId);
    this.#byToken.delete(session.sessionToken);
  }

  get(sessionId: string): GitSession | undefined {
    return this.#byId.get(sessionId);
  }

  byToken(token: string): GitSession | undefined {
    return this.#byToken.get(token);
  }
}
