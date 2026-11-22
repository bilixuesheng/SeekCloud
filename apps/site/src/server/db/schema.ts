import type {
  ErrorCode,
  PullRequestState,
  RepoDiff,
  SessionEventBody,
  SessionRepo,
  SessionStatusDetail,
  ThinkingEffort,
} from "@seekcloud/protocol";
import { SESSION_STATUSES, TURN_END_REASONS } from "@seekcloud/protocol";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { WebTool } from "../ports";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull();

/** 管理员。开源版只有一个账户（ADR 0008）：首次设置密码时建这一行，会话、环境都挂在它下面。 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // 管理员密码的 scrypt 哈希，写法见 auth/password.ts。
  passwordHash: text("password_hash").notNull(),
  // 昵称：SeekCloud 称呼管理员时用（侧栏、首页的问候语，以后还有 Agent 的系统提示词）。
  // 首次设置时填；这一列加上之前就设置好的部署是 null。
  nickname: text("nickname"),
  createdAt: createdAt(),
});

/** 网页的登录状态。Cookie 里放随机令牌，这里只存它的哈希。（"会话"专指和 Agent 的对话，这里不用这个词。） */
/**
 * 登录状态：浏览器的 Cookie，或者安卓 App 的设备令牌（#177）。都只存哈希。设置里的设备列表就是这张表。
 * App 的令牌每次用都顺延有效期；浏览器的照旧从登录时算 30 天。最后使用的时间和 IP 最多一分钟记一次。
 */
export const loginSessions = pgTable("login_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** browser：Cookie；app：放在 Authorization 里的设备令牌。 */
  client: text("client", { enum: ["browser", "app"] })
    .notNull()
    .default("browser"),
  /** App 登录时传上来的设备名（手机型号这类），当普通文字显示。浏览器的为空。 */
  deviceName: text("device_name"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastIp: text("last_ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const networkAccess = pgEnum("network_access", ["none", "default", "custom", "full"]);

export const environments = pgTable("environments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  networkAccess: networkAccess("network_access").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(),
});

/**
 * 沙箱宿主机。宿主机守护进程用宿主机密钥连上主站（hosts/hub.ts）；密钥只存 SHA-256 哈希，
 * 用 pnpm host:create 生成、pnpm host:revoke 吊销。不属于哪个人：宿主机是整个部署的。
 */
export const hosts = pgTable("hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: createdAt(),
  // 吊销的时间。吊销以后这把密钥连不上，已有的连接立即断开。
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // 下面几项是最近一次连上时记下的，给运行状况看；也用来在主站重启以后接上序号。
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  protocol: integer("protocol"),
  version: text("version"),
  // 守护进程这次启动的标识。同一个进程重连上来时，主站从 lastReceivedSeq 接着收，不重复处理。
  instance: text("instance"),
  lastReceivedSeq: integer("last_received_seq").notNull().default(0),
});

/** 关联的 GitHub 账号和它的授权令牌（加密存放）。刷新令牌只在主站。令牌失效或解除关联时删掉这一行。 */
export const githubTokens = pgTable("github_tokens", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // GitHub 的 login，显示用。
  login: text("login").notNull(),
  // GitHub 的用户编号和显示名：提交作者用（<编号>+<login>@users.noreply.github.com，#27）。
  // 这两列加上之前关联的为空，下次重新关联时补上。
  githubId: text("github_id"),
  name: text("name"),
  accessToken: text("access_token").notNull(),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
  refreshToken: text("refresh_token").notNull(),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/**
 * 导出数据：pending 等后台任务打包，building 正在打包，ready 可以下载（到 expiresAt 为止），
 * failed 没打成（不算进"24 小时一次"），expired 过期、文件已删。
 */
export const exportStatus = pgEnum("export_status", [
  "pending",
  "building",
  "ready",
  "failed",
  "expired",
]);

export const dataExports = pgTable(
  "data_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: exportStatus("status").notNull().default("pending"),
    // 压缩包多大，下载页上显示。
    sizeBytes: integer("size_bytes"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("data_exports_user").on(t.userId, t.createdAt)],
);

export const sessionStatus = pgEnum("session_status", SESSION_STATUSES);

/**
 * 侧栏里的分组（#153）：一个分组一个标题，在置顶和"最近"之间，按 sort_key 从小到大排（新建的在最后）。
 * 删掉分组时里面的会话回到"最近"。
 */
export const sessionGroups = pgTable(
  "session_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortKey: doublePrecision("sort_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("session_groups_user").on(t.userId)],
);

/** 会话。对外（网址、接口、会话分支名）用短 ID，内部和宿主机之间用 id。 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shortId: text("short_id").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: sessionStatus("status").notNull(),
    // 状态的附加说明，比如正在准备沙箱。
    statusDetail: text("status_detail").$type<SessionStatusDetail>(),
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    model: text("model").notNull(),
    effort: text("effort").$type<ThinkingEffort>().notNull(),
    // 最后一条会话事件的序号。追加事件时在这一行上加锁取号，保证序号连续、不重复。
    lastSeq: integer("last_seq").notNull().default(0),
    // 置顶的时间：侧栏里置顶的会话放在最上面一组。没置顶时为空。置顶的不在分组里。
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    // 在侧栏的哪个分组里（#153）；没分组（在"最近"或置顶里）时为空。
    groupId: uuid("group_id").references(() => sessionGroups.id, { onDelete: "set null" }),
    // 侧栏里的顺序（#153）：置顶、每个分组、"最近"里都按它从大到小排。"最近"里的会话有新动静时记成
    // 当时的毫秒数，回到最上面；拖动时取前后两个的中间值（sidebar.ts）。
    sortKey: doublePrecision("sort_key").notNull().default(0),
    // 有新内容（照 Claude）：回合结束或会话失败时没人开着这个会话就标上，打开就消掉；也能在菜单里手动标。
    unread: boolean("unread").notNull().default(false),
    // 沙箱在哪台宿主机上。派给宿主机时记下；宿主机只能上报自己名下的会话的事件。
    hostId: uuid("host_id").references(() => hosts.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_updated_idx").on(t.userId, t.updatedAt)],
);

/** 会话用到的仓库。position 为 0 的是主仓库。 */
export const sessionRepos = pgTable(
  "session_repos",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    fullName: text("full_name").notNull(),
    baseBranch: text("base_branch").notNull(),
    branch: text("branch").notNull(),
    access: text("access").$type<SessionRepo["access"]>().notNull(),
    // 会话分支上最近的 PR，由 GitHub 的 pull_request webhook 更新。
    prNumber: integer("pr_number"),
    prState: text("pr_state").$type<PullRequestState>(),
    // webhook 可能乱序到达：只接受比这个更新的。
    prUpdatedAt: timestamp("pr_updated_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.position] }),
    // PR 的 webhook 按分支找会话。会话分支的名字里有会话短 ID，几乎不会重名；仓库名再比一次（不分大小写）。
    index("session_repos_branch").on(t.branch),
  ],
);

export const turnStatus = pgEnum("turn_status", ["running", ...TURN_END_REASONS]);

/** 回合：从用户发出一条消息开始，到 Agent 停下来等用户为止。number 从 1 开始。 */
export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    // 这个回合发给 Agent 的消息。
    input: text("input").notNull(),
    status: turnStatus("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [unique("turns_session_number").on(t.sessionId, t.number)],
);

/** Agent 工作时用户发的消息：回合结束后合成下一回合的开头。撤回、立即发送、开始下一回合时删掉。 */
export const queuedMessages = pgTable(
  "queued_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // 发的先后：同一时刻发的几条也要按顺序合起来，时间戳分不出先后。
    seq: integer("seq").generatedAlwaysAsIdentity().notNull(),
    text: text("text").notNull(),
    // 发的时候选了别的模型或思考强度：从它开始的那个回合起生效。
    model: text("model"),
    effort: text("effort").$type<ThinkingEffort>(),
    createdAt: createdAt(),
  },
  (t) => [index("queued_messages_session").on(t.sessionId, t.seq)],
);

/** 会话事件：用户消息、状态变化和规范化的 Agent 事件。seq 是会话内从 1 开始的连续序号。 */
export const sessionEvents = pgTable(
  "session_events",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    turn: integer("turn"),
    body: jsonb("body").$type<SessionEventBody>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

/**
 * 置顶的消息（照 Claude）：会话里某一条 Agent 回复，seq 是它在会话事件里的序号。
 * title 是几个字的短标题，显示在这条消息上方和左上角的置顶列表里；为空表示还在生成。
 */
export const messagePins = pgTable(
  "message_pins",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    title: text("title"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

/**
 * 会话分支对比基础分支的改动（改动面板，#27）：宿主机每个回合结束时发一份，每个仓库只留最新的
 * （turn 大的盖过小的，补发来的旧的不盖新的）。
 */
export const workspaceDiffs = pgTable(
  "workspace_diffs",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    turn: integer("turn").notNull(),
    body: jsonb("body").$type<RepoDiff>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.repo] })],
);

export const accessEvent = pgEnum("access_event", ["login", "session_start", "message"]);

/**
 * 登录、发起会话、发消息时的客户端网络。《网络安全法》要求网络日志留存不少于 6 个月，保存 180 天。
 * 只存储，不用于别的用途。
 */
export const accessLogs = pgTable(
  "access_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    event: accessEvent("event").notNull(),
    // IPv4 原样；IPv6 只留前 64 位（一台设备的 IPv6 地址经常变），写成 2001:db8:1:2::/64
    network: text("network").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("access_logs_user").on(t.userId, t.at), index("access_logs_at").on(t.at)],
);

/**
 * 全站设置：管理员在设置窗口里改的配置，一项一行。value 的形状由 server/settings.ts 里对应的定义决定，
 * 没有这一行就是默认值。
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/**
 * 模型服务的提供方（模型网关，#26）。主干现在只有 DeepSeek 官方一个；多提供方在 #112 里加。
 * key 用 SEEKCLOUD_SECRET_KEY 加密存放，接口从不返回原文。
 */
export const modelProviders = pgTable("model_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  // 程序里认它用的标识，比如 deepseek。
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // Anthropic Messages 兼容接口的地址，比如 https://api.deepseek.com/anthropic。
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key"),
  keySetAt: timestamp("key_set_at", { withTimezone: true }),
  // 上游说 key 不对（401、403）的时间；换了 key 以后清掉。设置里据此提示管理员检查 key。
  keyRejectedAt: timestamp("key_rejected_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * 模型调用的用量（#26）：每次调用一条，只记 token 数，不换算成钱。purpose 是用途：Agent 的调用、起标题、
 * 判断是否在等输入这些（gateway/purposes.ts）。平台自己发起的调用没有会话时 session_id 为空。
 */
export const modelUsage = pgTable(
  "model_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    turnId: uuid("turn_id"),
    purpose: text("purpose").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    // 中途断开、上游出错的为 false：已返回的用量照记，拿不到就是 0。
    complete: boolean("complete").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("model_usage_session").on(t.sessionId), index("model_usage_at").on(t.createdAt)],
);

/**
 * 联网工具的调用（模型网关，#26）：网关替沙箱做的联网搜索和网页抓取，一次一条，记次数不记 token。
 * provider 是转给了哪个提供方；主站自己去抓的网页为空。
 */
export const webToolUsage = pgTable(
  "web_tool_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    turnId: uuid("turn_id"),
    tool: text("tool").$type<WebTool>().notNull(),
    provider: text("provider"),
    // 出错、被拒绝的为 false。
    ok: boolean("ok").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("web_tool_usage_session").on(t.sessionId),
    index("web_tool_usage_at").on(t.createdAt),
  ],
);

/**
 * 沙箱经 Files 接口传给提供方的文件（dsh 把图片传上去，Messages 里按文件 ID 引用）。
 * 同一把 key 下所有会话的文件都在提供方那里，所以网关自己记每个文件是哪个会话传的：
 * 列表、查看、删除、在 Messages 里引用，都只认本会话的。文件只在传上去的那个提供方那里有。
 */
export const modelFiles = pgTable(
  "model_files",
  {
    // 提供方给的文件 ID。
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    // 提供方记的上传时间（列表按它排）。
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("model_files_session").on(t.sessionId, t.uploadedAt)],
);

/**
 * 上游模型服务的原始报错（ADR 0007 的 2026-11-14 修订）：只给管理员看，按参考号查，不进沙箱。
 * 保存 30 天（maintenance.ts）。
 */
export const upstreamErrors = pgTable(
  "upstream_errors",
  {
    ref: text("ref").primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    // 归到哪一类（ErrorCode）。
    code: text("code").$type<ErrorCode>().notNull(),
    // 上游的 HTTP 状态码；连不上时为空。
    status: integer("status"),
    // 上游的响应体（截到 16 KB），或者连不上时的错误说明。
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("upstream_errors_at").on(t.createdAt)],
);
