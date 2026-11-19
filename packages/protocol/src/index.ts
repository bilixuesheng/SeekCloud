// 主站和宿主机之间的消息，以及规范化的会话事件。主站、宿主机守护进程和测试都用这里的定义。

/**
 * 主站和宿主机之间协议的版本。什么时候升（2026-11-17 定的规矩）：
 *
 * - 不升：加一种新的命令或事件；给已有的命令、事件加一个可以不填的字段。收到不认识的命令，宿主机记一笔、
 *   当作不支持；收到不认识的事件，主站记一笔丢掉；不认识的字段两边都忽略。
 * - 升一个版本：改了已有字段的意思或类型、删掉字段、把可以不填的改成必填、改了握手或帧的格式（link.ts）。
 * - 相差一个版本要能互通：升版本的那一边同时还会说上一个版本（MIN_PROTOCOL_VERSION = PROTOCOL_VERSION - 1），
 *   连上时两边取都会说的最新版本（negotiateProtocol）。一键更新先更新主站、再更新宿主机（或者反过来）时，
 *   中间那段时间靠它接着用。说不到一起的宿主机照样连得上，但主站不往上派新会话。
 * - 不再需要说旧版本时，把 MIN_PROTOCOL_VERSION 提上来。
 */
export const PROTOCOL_VERSION = 1;

/** 这一边还会说的最旧的协议版本。 */
export const MIN_PROTOCOL_VERSION = 1;

/** 两边都会说的最新版本；说不到一起时为 null。 */
export function negotiateProtocol(
  a: { protocol: number; minProtocol: number },
  b: { protocol: number; minProtocol: number },
): number | null {
  const newest = Math.min(a.protocol, b.protocol);
  return newest >= Math.max(a.minProtocol, b.minProtocol) ? newest : null;
}

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

/**
 * 模型支持这一档就用这一档；不支持就换成它支持的、离得最近的一档（一样近时取低的）。
 * 换模型、用设置里的默认值时用它，免得落到模型不支持的档位上。模型一档都不支持时返回 undefined。
 */
export function fitEffort(
  efforts: readonly ThinkingEffort[],
  effort: ThinkingEffort,
): ThinkingEffort | undefined {
  if (efforts.includes(effort)) return effort;
  const at = THINKING_EFFORTS.indexOf(effort);
  const rank = (e: ThinkingEffort) =>
    Math.abs(THINKING_EFFORTS.indexOf(e) - at) * 2 + (THINKING_EFFORTS.indexOf(e) > at ? 1 : 0);
  return [...efforts].sort((a, b) => rank(a) - rank(b))[0];
}

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

/** 提交的作者和提交者。 */
export interface Committer {
  name: string;
  email: string;
}

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
      /**
       * 提交作者：管理员关联的 GitHub 账号（显示名，没有就用 login；邮箱是 <编号>+<login>@users.noreply.github.com）。
       * 宿主机写进沙箱的 git 配置，签名服务按它核对提交者（#27）。没关联 GitHub、或者关联得早没有编号时不填。
       */
      committer?: Committer;
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
  /**
   * 管理员点了"停止"：停下这个回合，不停后台命令；宿主机照常补提交和推送。
   * 主站这时已经把回合记成已停止，之后这个回合的事件都会被忽略。
   */
  | { type: "stop_turn"; sessionId: string; turnId: string }
  /** 每个回合都带上模型和思考强度：用户中途切换后，从下一个回合起生效。 */
  | {
      type: "start_turn";
      sessionId: string;
      turnId: string;
      text: string;
      model: string;
      effort: ThinkingEffort;
      /**
       * 这个会话以前没有哪个回合到过 Agent：Agent 那边还没有这个会话，新建就是了。
       * 为假时 Agent 必须接着原来的会话，接不上就让回合失败，不悄悄开一个新的（#25）。旧版本的主站不填，按假处理。
       */
      firstTurn?: boolean;
    };

/** 宿主机发给主站的事件。 */
/**
 * 模型的进度：正在思考还是在写正文，这个回合到现在模型一共输出了多少 token（思考和正文都算，
 * 一个回合里的多次模型调用累加，下一个回合从 0 数起）。
 * 只推送、不落库：模型在输出时宿主机隔 0.5 到 1 秒发一次，主站原样转给浏览器，断线重连也不补。
 * 浏览器在没有工具在跑时把它写在对话底部用时的后面，数字在两次之间连贯地数上去
 * （照 Claude Code，2026-11-15 用户定的）。
 */
export interface ModelProgress {
  phase: "thinking" | "text";
  tokens: number;
}

/**
 * 模型正在输出的一段文字（增量）：思考或正文。和进度一样只推送、不落库，这一步结束时照旧落一条完整的 message。
 * 浏览器一边收一边让字浮现；完整的 message 到了以后接过已经显示的部分，不重播动画（#31 的逐字输出）。
 */
export interface TextDelta {
  kind: "thinking" | "text";
  text: string;
}

/** 只推送、不落库的事件：SSE 的事件名和内容。断线重连也不补。 */
export type LiveEvent =
  | { event: "progress"; data: ModelProgress }
  | { event: "delta"; data: TextDelta };

export type HostEvent =
  | { type: "sandbox.ready"; sessionId: string }
  | { type: "sandbox.failed"; sessionId: string; error: SafeError }
  | { type: "agent"; sessionId: string; turnId: string; event: AgentEvent }
  | ({ type: "progress"; sessionId: string; turnId: string } & ModelProgress)
  | ({ type: "delta"; sessionId: string; turnId: string } & TextDelta);

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
  /** 置顶的时间，没置顶时为 null。归档时自动取消置顶。 */
  pinnedAt: string | null;
  /** 有新内容：回合结束时没人开着这个会话就为真，打开就消掉；也能在菜单里手动标。 */
  unread: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 置顶的一条消息：seq 是那条 Agent 回复的事件序号；title 是短标题，为 null 表示还在生成。 */
export interface MessagePin {
  seq: number;
  title: string | null;
  createdAt: string;
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

export * from "./link";
