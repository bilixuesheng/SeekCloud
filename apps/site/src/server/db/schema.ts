import type {
  PullRequestState,
  SessionEventBody,
  SessionRepo,
  SessionStatusDetail,
  ThinkingEffort,
} from "@seekcloud/protocol";
import { SESSION_STATUSES, TURN_END_REASONS } from "@seekcloud/protocol";
import {
  boolean,
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

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull();

/** 管理员。开源版只有一个账户（ADR 0008）：首次设置密码时建这一行，会话、环境都挂在它下面。 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // 管理员密码的 scrypt 哈希，写法见 auth/password.ts。
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

/** 网页的登录状态。Cookie 里放随机令牌，这里只存它的哈希。（"会话"专指和 Agent 的对话，这里不用这个词。） */
export const loginSessions = pgTable("login_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
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

/** 关联的 GitHub 账号和它的授权令牌（加密存放）。刷新令牌只在主站。令牌失效或解除关联时删掉这一行。 */
export const githubTokens = pgTable("github_tokens", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // GitHub 的 login，显示用。
  login: text("login").notNull(),
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
