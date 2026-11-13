// 主站和宿主机之间的消息，以及规范化的会话事件。主站、宿主机守护进程和测试都用这里的定义。

export const PROTOCOL_VERSION = 1;

/** 会话状态，只有这六种。界面上的细分提示（正在准备沙箱之类）放在 SessionStatusDetail 里。 */
export const SESSION_STATUSES = [
  "queued",
  "running",
  "waiting",
  "dormant",
  "archived",
  "failed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** 状态的附加说明，不是新状态。没有说明时为 null。 */
export const SESSION_STATUS_DETAILS = ["preparing_sandbox"] as const;
export type SessionStatusDetail = (typeof SESSION_STATUS_DETAILS)[number] | null;

/** 会话状态和它的附加说明，总是一起出现。 */
export interface SessionState {
  status: SessionStatus;
  detail: SessionStatusDetail;
}

export const THINKING_EFFORTS = ["off", "low", "high", "max"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export const TURN_END_REASONS = ["completed", "stopped", "failed"] as const;
export type TurnEndReason = (typeof TURN_END_REASONS)[number];

/**
 * 出错时的类别。给用户看的只有类别、上游的 HTTP 状态码和参考号（ADR 0007）：
 * 上游的原始报错可能带着后台配置的 API 端点或密钥片段，一律不进协议，只记在宿主机的日志里，用参考号查。
 */
export const ERROR_CODES = [
  /** 模型服务连不上或返回 5xx。 */
  "model_unavailable",
  /** 模型服务限流（429）。 */
  "model_rate_limited",
  /** 模型服务拒绝了请求（其余 4xx，比如内容审核）。 */
  "model_rejected",
  /** 对话超出模型的上下文。 */
  "context_too_long",
  /** 等模型服务超时。 */
  "timeout",
  /** 建不了沙箱（宿主机没资源、镜像拉不下来）。 */
  "sandbox_unavailable",
  /** 克隆仓库失败。 */
  "repo_clone_failed",
  /** 其他内部错误。 */
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 可以给用户看的错误：只有这三样，没有任何自由文本。 */
export interface SafeError {
  code: ErrorCode;
  /** 上游返回的 HTTP 状态码，没有就不填。 */
  status?: number;
  /** 参考号：宿主机日志里这条原始报错的编号，用户报问题时给我们看。 */
  ref?: string;
}

/**
 * 规范化的 Agent 事件：Agent 适配层把 dsh 的事件转成这些。
 * 文本和思考的增量只推送、不落库；这里的事件都会存下来。
 */
export type AgentEvent =
  | { type: "turn.started" }
  /** 一步结束时的完整消息。thinking 是这一步的思考过程。 */
  | { type: "message"; text: string; thinking?: string }
  | { type: "tool.call"; callId: string; name: string; input: unknown }
  | { type: "tool.result"; callId: string; output: string; isError: boolean }
  /** 待办清单的整表快照。 */
  | { type: "todo"; items: TodoItem[] }
  | { type: "turn.ended"; reason: TurnEndReason; error?: SafeError };

/** push：装了 App，可以推送；read：只读挂载的公开仓库。 */
export const REPO_ACCESS = ["push", "read"] as const;

export interface SessionRepo {
  /** owner/name */
  fullName: string;
  baseBranch: string;
  /** 会话分支：seekcloud/<会话短ID>。 */
  branch: string;
  access: (typeof REPO_ACCESS)[number];
}

/**
 * AI 标识的两个开关（全站设置，默认都开）。
 * signature：Agent 写到 GitHub 上的 issue、PR、评论、review 末尾加署名；
 * commitTrailer：Agent 的提交说明末尾加 AI 生成的尾注。
 */
export interface AiLabels {
  signature: boolean;
  commitTrailer: boolean;
}

/** 没有下发过开关时（比如旧版本的主站）按都开处理。 */
export const DEFAULT_AI_LABELS: AiLabels = { signature: true, commitTrailer: true };

/** 主站发给宿主机的命令。 */
export type HostCommand =
  | {
      type: "prepare_sandbox";
      sessionId: string;
      /** 第一个是主仓库，Agent 的工作目录。 */
      repos: SessionRepo[];
      environmentId: string;
      model: string;
      effort: ThinkingEffort;
      aiLabels: AiLabels;
    }
  /** 管理员在设置里改了 AI 标识的开关：运行中的会话跟着变，不用重开。 */
  | { type: "set_ai_labels"; sessionId: string; aiLabels: AiLabels }
  /**
   * 下发或刷新用户的 GitHub 访问令牌，给宿主机上的 Git 代理用（ADR 0003）。
   * 宿主机只放在内存里；令牌快过期时主站刷新后再发一次。
   */
  | { type: "set_github_token"; sessionId: string; token: string }
  /**
   * 用户在 Agent 工作时点了"立即发送"：插话，Agent 在当前回合的下一步读到它。
   * 要修改版 dsh 支持；宿主机还不支持时忽略，消息仍然记在会话里。
   */
  | { type: "inject_message"; sessionId: string; turnId: string; text: string }
  /**
   * 停掉并删除这个会话的沙箱（包括休眠的），不再回传事件。
   * 沙箱已经不在时什么也不做。
   */
  | { type: "destroy_sandbox"; sessionId: string }
  /** 每个回合都带上模型和思考强度：用户中途切换后，从下一个回合起生效。 */
  | {
      type: "start_turn";
      sessionId: string;
      turnId: string;
      text: string;
      model: string;
      effort: ThinkingEffort;
    };

/** 宿主机发给主站的事件。 */
export type HostEvent =
  | { type: "sandbox.ready"; sessionId: string }
  | { type: "sandbox.failed"; sessionId: string; error: SafeError }
  | { type: "agent"; sessionId: string; turnId: string; event: AgentEvent };

/**
 * 主站和宿主机之间的一帧（WebSocket，以后接上）。
 * seq 是发送方自己的递增序号；ack 是已经收到的对方的最大序号。断线重连后，双方补发对方没确认的帧。
 */
export type HostLinkFrame =
  | { seq: number; ack: number; command: HostCommand }
  | { seq: number; ack: number; event: HostEvent };

/** 会话分支上的 PR 状态，侧边栏和会话页按它显示图标。 */
export const PULL_REQUEST_STATES = ["open", "draft", "merged", "closed"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export interface PullRequestRef {
  number: number;
  state: PullRequestState;
}

/** 主站给浏览器的会话。对外只用会话短 ID。 */
export interface Session extends SessionState {
  shortId: string;
  title: string;
  /** 第一个是主仓库。pullRequest：会话分支上最近的 PR，没有时为 null。 */
  repos: Array<SessionRepo & { pullRequest: PullRequestRef | null }>;
  model: string;
  effort: ThinkingEffort;
  /** 会话用的环境的名字；环境被删掉了时为 null。 */
  environmentName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 会话事件流里的一条（主站 → 浏览器）。seq 是会话内从 1 开始的序号，断线后用 Last-Event-ID 续上。 */
export type SessionEvent = { seq: number; at: string; turn: number | null } & SessionEventBody;

export type SessionEventBody =
  /**
   * 用户的消息。queued：由这几条排队的消息变来（回合结束后合成下一回合的开头，或者立即发送）；
   * injected：Agent 工作时"立即发送"的插话。
   */
  | { type: "user.message"; text: string; queued?: string[]; injected?: boolean }
  /** Agent 工作时发的消息先排队，回合结束后作为下一回合的开头。处理之前可以撤回或立即发送。 */
  | { type: "message.queued"; id: string; text: string }
  /** 用户撤回了一条排队的消息。 */
  | { type: "message.withdrawn"; id: string }
  /** 用户换了模型或思考强度，从这个回合起生效。 */
  | { type: "model.changed"; model: string; effort: ThinkingEffort }
  /** error 只在变成 failed 时有。 */
  | ({ type: "status"; error?: SafeError } & SessionState)
  | AgentEvent;
