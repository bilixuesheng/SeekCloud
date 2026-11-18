// 主站依赖的外部能力和扩展点（ADR 0010）。测试里换成 src/testing 里的假实现。
//
// 扩展点：下游版本可以换掉的东西。每个扩展点在 AppDeps 里占一项，主干里只有单管理员的那一份实现，
// 主干自己在用。主干里不放下游的实现，也不放版本开关。

import type { ErrorCode } from "@seekcloud/protocol";
import type { Context, Env, Hono } from "hono";
import type { SettingKey, SettingValue } from "./settings";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** 接口出错时的返回体，见 errors.ts 的 apiError()。 */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** 发出这个请求的人。 */
export interface CurrentUser {
  /** users 表里的 ID。属于这个人的数据都按它过滤。 */
  id: string;
}

/**
 * 扩展点：身份来源。主干的实现是管理员密码登录（auth/admin-identity.ts）。
 *
 * 所有接口都经过它判断"这个请求是谁的"，自己不读登录状态。身份来源给的 ID 必须是 users 表里的一行：
 * 会话、环境、导出这些数据都挂在它下面。
 */
export interface Identity {
  /** 这个请求是谁的；没登录、登录状态过期或已退出时返回 undefined。 */
  currentUser(c: Context): Promise<CurrentUser | undefined>;
  /**
   * 没登录时 /api/me 回给浏览器的错误，浏览器按错误码决定显示哪个页面。
   * 主干在还没设置管理员时回 setup_required（显示首次设置），其余时候回 unauthorized（显示登录）。
   */
  loggedOut(c: Context): Promise<ApiErrorBody>;
  /**
   * 登录相关的接口，挂在 /api/auth 下面：首次设置、登录、改密码、退出这些。
   * 用 routes/router.ts 的 newRouter() 建的，会出现在接口文档（/api/openapi.json）里。
   */
  routes: Hono<Env>;
}

/** 在读写设置的人。 */
export interface SettingsActor {
  userId: string;
}

/**
 * 扩展点：设置的读写规则。全站设置（settings 表）的每一项，默认值是什么、这个人现在能不能改。
 * 主干的实现在 settings.ts 的 adminSettings：默认值照 settings.ts 写的，管理员都能改。
 */
export interface SettingsPolicy {
  /** 一项设置没改过（库里没有这一行，或者存的值不合现在的形状）时的值。 */
  defaultValue<K extends SettingKey>(
    key: K,
    actor: SettingsActor,
  ): SettingValue<K> | Promise<SettingValue<K>>;
  /** 这个人现在能不能改这一项。不能改时接口回 403 setting_locked。 */
  canWrite(key: SettingKey, actor: SettingsActor): boolean | Promise<boolean>;
}

// ---- 模型网关（#26）的三个扩展点 ----

/** 模型调用的用途，记进用量。平台自己发起的调用（起标题、判断是否在等输入……）也走网关，用途不同。 */
export const MODEL_PURPOSES = [
  /** 沙箱里的 Agent 调用模型。 */
  "agent",
  /** 给会话起标题。 */
  "title",
  /** 判断回合结束时 Agent 是不是在等管理员回答（#139）。 */
  "waiting_check",
  /** 置顶消息的短标题。 */
  "pin_title",
  /** 安全审查。 */
  "safety",
  /** 看图。 */
  "vision",
  /** 生成 PR 标题。 */
  "pr_title",
] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

/** 一次模型调用是谁、为了什么发起的。 */
export interface ModelCall {
  purpose: ModelPurpose;
  /** 记在谁名下：会话的主人；平台调用时是触发它的人。 */
  userId: string | null;
  sessionId: string | null;
  /** 沙箱里的调用发生在哪个回合；不在回合里（或平台调用）时为空。 */
  turnId: string | null;
  /** 我们的模型 ID（/api/models 里的那些），不是上游的模型名。 */
  model: string;
}

/** 一次调用的用量。上游出错、中途断开的也报：已返回的照记，拿不到的是 0，complete 为 false。 */
export interface ModelUsage extends ModelCall {
  /** 提供方的标识（ProviderTarget.provider）。 */
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  complete: boolean;
}

/** 联网工具：网关替沙箱做的联网搜索和网页抓取。按次数记，不记 token。 */
export const WEB_TOOLS = ["web_search", "web_fetch"] as const;
export type WebTool = (typeof WEB_TOOLS)[number];

/** 一次联网搜索或网页抓取是谁发起的。 */
export interface WebToolCall {
  tool: WebTool;
  userId: string | null;
  sessionId: string | null;
  turnId: string | null;
}

/** 一次联网工具调用的记录。provider 是转给了哪个提供方（主站自己去抓的网页为空）；ok 为假是出错或被拒绝。 */
export interface WebToolUsage extends WebToolCall {
  provider: string | null;
  ok: boolean;
}

/** 准入的答复：放行，或者不放行加一句说明（原样回给调用方，沙箱看得到，不能带上游的信息）。 */
export type Admission = { ok: true } | { ok: false; message: string };

/**
 * 扩展点：模型网关的准入和记录。转发前问一次放不放行，转发后报一次用量。
 * 主干的实现（gateway/trunk.ts）：一律放行，模型调用写进 model_usage，联网工具写进 web_tool_usage。
 * 用量上限在多提供方的规格里做（#112）。
 */
export interface ModelAdmission {
  admit(call: ModelCall): Promise<Admission>;
  record(usage: ModelUsage): Promise<void>;
  admitWebTool(call: WebToolCall): Promise<Admission>;
  recordWebTool(usage: WebToolUsage): Promise<void>;
}

/** 一个上游提供方：往哪里发、发之前怎么改写请求。 */
export interface ProviderTarget {
  /** 提供方的标识，记进用量、报错和上传的文件。 */
  provider: string;
  /**
   * 上游接口的完整地址。path 是沙箱请求的路径：/v1/messages、/v1/files、/v1/files/{id}、/v1/tools/search，
   * 查询参数由网关自己加。
   */
  url(path: string): string;
  /**
   * 发给上游的请求头：只留白名单里的（anthropic-version、anthropic-beta），换上 key 和 SeekCloud 自己的 user-agent。
   * 不带 dsh 的 x-deepseek-harness-*、宿主机凭据、会话令牌和 Cookie。path 同 url()：不同接口的认证方式可能不一样。
   */
  headers(path: string, incoming: Headers): Headers;
  /**
   * Messages 请求发出去之前改写：请求头照 headers("/v1/messages", …)；
   * 剥掉 dsh 夹带的字段（dsh_*）和 user_id，换成上游的模型名。不改动传进来的对象。
   */
  prepare(request: { headers: Headers; body: Record<string, unknown> }): {
    headers: Headers;
    body: Record<string, unknown>;
  };
}

/** 不分模型的接口：Files（沙箱上传给模型看的图片）和联网搜索。 */
export type ProviderService = "files" | "web_search";

/** 一次不分模型的调用是谁发起的。 */
export interface ServiceCall {
  service: ProviderService;
  userId: string | null;
  sessionId: string | null;
}

/**
 * 扩展点：提供方路由。给定模型（或者不分模型的接口），返回依次尝试的提供方。网关只在上游还没开始返回内容时出错才试下一个。
 * 主干的实现（gateway/trunk.ts）只有一项（DeepSeek 官方），所以行为就是"出错时不自动换提供方"。
 * 返回空数组表示现在没有可用的提供方（比如还没填 key）。
 *
 * 上传的文件只在传上去的那个提供方那里有：Messages 请求里引用了文件时，网关只用存着这些文件的提供方。
 */
export interface ProviderRouting {
  route(model: string, call: ModelCall): Promise<ProviderTarget[]>;
  service(call: ServiceCall): Promise<ProviderTarget[]>;
}

/** 一次上游出错，网关记下的全部内容。 */
export interface UpstreamFailure {
  ref: string;
  code: ErrorCode;
  /** 给沙箱和浏览器的状态码（上游的，400–599 之间才有）。 */
  status?: number;
  provider: string;
  /** 上游的原始报错：状态码（连不上时为空）和响应体。只给管理员看，不进沙箱（ADR 0007）。 */
  upstream: { status: number | null; body: string };
  createdAt: string;
}

/**
 * 扩展点：报错的呈现。按参考号查一次上游出错时，浏览器里看到哪些内容。
 * 主干的实现：管理员看到全部，包括上游的原始报错（ADR 0007 的 2026-11-14 修订）。
 */
export interface ErrorPresentation {
  present(failure: UpstreamFailure, viewer: CurrentUser): Record<string, unknown>;
}
