import { randomInt } from "node:crypto";
import type {
  AgentEvent,
  AiLabels,
  Committer,
  HostCommand,
  HostEvent,
  LiveEvent,
  MessagePin,
  PullRequestState,
  RepoDiff,
  SafeError,
  Session,
  SessionEvent,
  SessionEventBody,
  SessionRepo,
  SessionState,
  ThinkingEffort,
} from "@seekcloud/protocol";
import { fitEffort, MAX_PUSH_FOLLOW_UPS, modelRef, parseModelRef } from "@seekcloud/protocol";
import { and, asc, desc, eq, gt, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import type { AppDeps } from "../app";
import type { Database, Tx } from "../db/client";
import {
  environments,
  githubTokens,
  messagePins,
  queuedMessages,
  sessionEvents,
  sessionRepos,
  sessions,
  turns,
  workspaceDiffs,
} from "../db/schema";
import { githubNotConnected } from "../errors";
import { githubAccessToken, withGitHubToken } from "../github/tokens";
import { ModelCatalog } from "../models/providers";
import { readSetting } from "../settings";
import { readAgentArchive, removeAgentArchive, saveAgentArchive } from "./agent-archive";
import { judgeTurnEnd } from "./awaiting-input";
import { type PinTitles, pinTitle } from "./pin-title";
import { toSafeError } from "./safe-error";
import { naturalKey, Sidebar } from "./sidebar";
import { Topic } from "./topic";
import type { WaitingCheck } from "./waiting-check";

/** 一次读多少条事件。 */
export const EVENT_PAGE = 500;

/** 会话列表最多给这么多个最近有动静的会话；置顶的不受这个数限制。 */
const LIST_LIMIT = 200;

export const sessionErrors = {
  github_not_connected: { status: 409, message: githubNotConnected.error.message },
  repo_not_found: { status: 404, message: "仓库不存在，或 SeekCloud 无权访问" },
  branch_not_found: { status: 400, message: "仓库中不存在该分支" },
  environment_not_found: { status: 404, message: "环境不存在" },
  model_not_found: { status: 400, message: "模型不存在或已下线" },
  model_gone: { status: 409, message: "该会话使用的模型已不可用，请换一个模型后再发送" },
  model_not_configured: {
    status: 409,
    message: "尚无可用的模型，请在“设置 → 模型”中填写 DeepSeek API key 或添加模型提供商",
  },
  session_not_found: { status: 404, message: "会话不存在" },
  session_closed: { status: 409, message: "会话已归档，请先取消归档再发送消息" },
  queued_not_found: { status: 404, message: "该消息已发送或已撤回" },
  nothing_running: { status: 409, message: "当前没有正在运行的回合" },
  session_archived: { status: 409, message: "已归档的会话不能置顶，请先取消归档" },
  message_not_found: { status: 404, message: "该消息不存在，或不是 Agent 的回复" },
} as const;

export type SessionError = keyof typeof sessionErrors;
type Result<T> = { ok: true; value: T } | { ok: false; error: SessionError };

export interface NewSession {
  /** owner/name。不填就是不使用仓库（#191）：不查 GitHub，沙箱里不克隆，Agent 在空的工作目录里工作。 */
  repo?: string;
  /** 和 repo 一起填。 */
  baseBranch?: string;
  /** 不填就用默认环境。 */
  environmentId?: string;
  /** 不填就用默认模型和思考强度。 */
  model?: string;
  effort?: ThinkingEffort;
  text: string;
}

/** 打开的一个会话：读事件、订阅新事件。 */
export interface SessionHandle {
  session: Session;
  eventsAfter(seq: number): Promise<SessionEvent[]>;
  /** 有新事件时调用 listener。返回取消订阅的函数。 */
  subscribe(listener: () => void): () => void;
  /** 模型的进度和正在输出的文字（只推送、不落库）。返回取消订阅的函数。 */
  subscribeLive(listener: (event: LiveEvent) => void): () => void;
}

type SessionRow = typeof sessions.$inferSelect;

/** 发消息的结果：开始了下一个回合，或者 Agent 还在工作、先排队。 */
export type SendOutcome =
  | { started: Session }
  | { queued: { id: string; text: string } }
  | { injected: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 去掉了容易看混的 i、l、o、u。短 ID 要难以猜到，所以用 node:crypto 的随机数。
const SHORT_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const newShortId = () =>
  Array.from({ length: 8 }, () => SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)]).join("");

/** 会话分支名。 */
export const sessionBranch = (shortId: string) => `seekcloud/${shortId}`;

/** 会话标题先取第一句话的开头；以后可以改名。 */
function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 50 ? `${line.slice(0, 50)}…` : line;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const toSessionRepo = (r: typeof sessionRepos.$inferSelect): SessionRepo => ({
  fullName: r.fullName,
  baseBranch: r.baseBranch,
  branch: r.branch,
  access: r.access,
});

/**
 * 会话编排：会话和回合的状态，以及和宿主机之间的命令、事件。
 *
 * 状态的变化：新会话先是排队中；有宿主机就交给它准备沙箱，变成运行中；
 * 回合结束后变成等待回复；用户再发消息，开始下一个回合，又变成运行中。沙箱建不起来就是失败。
 */
export class Sessions {
  readonly #deps: AppDeps;
  /** 某个会话有了新事件。键是会话的内部 id。 */
  readonly #events = new Topic<void>();
  /** 某个会话只推送、不落库的事件（模型进度、文字增量），键是会话 id。 */
  readonly #live = new Topic<LiveEvent>();
  /** 某个用户的某个会话有变化。键是用户 id，值是会话短 ID。 */
  readonly #changes = new Topic<string>();
  /** 某个用户的侧栏分组有变化（#153）。键是用户 id。 */
  readonly #groupChanges = new Topic<void>();
  /** 侧栏的分组和顺序（#153，sidebar.ts）。 */
  readonly sidebar: Sidebar;
  /** 后台还没做完的"等你输入"判断（#judgeLater）。 */
  readonly #judging = new Set<Promise<void>>();

  /** 平台自己发起的模型调用（platform-call.ts）：不给就只用规则。 */
  readonly #waitingCheck: WaitingCheck | undefined;
  readonly #pinTitles: PinTitles | undefined;
  /** 提供方和模型（#113）。 */
  readonly #models: ModelCatalog;

  /** 提供方和模型：接口里列模型、核对设置用。 */
  get models(): ModelCatalog {
    return this.#models;
  }

  constructor(
    deps: AppDeps,
    options: { models?: ModelCatalog; waitingCheck?: WaitingCheck; pinTitles?: PinTitles } = {},
  ) {
    this.#deps = deps;
    this.#models = options.models ?? new ModelCatalog(deps);
    this.#waitingCheck = options.waitingCheck;
    this.#pinTitles = options.pinTitles;
    this.sidebar = new Sidebar(deps, {
      sessions: (userId, shortIds) => {
        for (const shortId of shortIds) this.#changes.emit(userId, shortId);
      },
      groups: (userId) => this.#groupChanges.emit(userId, undefined),
    });
    deps.host?.connect(
      (event) => this.handleHostEvent(event),
      () => void this.dispatchQueued(),
    );
  }

  async create(userId: string, input: NewSession): Promise<Result<Session>> {
    const { db, clock, github } = this.#deps;
    const environmentId = await this.#environmentFor(userId, input.environmentId);
    if (!environmentId) return { ok: false, error: "environment_not_found" };
    // 一个能用的模型都没有（没填 key、没加提供方）：现在就说清楚，不等沙箱起来以后每次调模型都失败。
    const model = input.model
      ? await this.#models.find(normalizeModelRef(input.model))
      : await this.#models.defaultModel(userId);
    if (!model) {
      const none = (await this.#models.available()).every((p) => p.models.length === 0);
      return { ok: false, error: none ? "model_not_configured" : "model_not_found" };
    }
    // 没指定思考强度就用设置里的默认值；模型不支持那一档时换成最近的一档
    const effort = chooseEffort(
      model.efforts,
      input.effort,
      await readSetting(this.#deps, "default_effort", { userId }),
    );
    if (!effort) return { ok: false, error: "model_not_found" };
    const call = {
      purpose: "agent" as const,
      userId,
      sessionId: null,
      turnId: null,
      model: model.ref,
    };
    if ((await this.#deps.providerRouting.route(model.ref, call)).length === 0) {
      return { ok: false, error: "model_not_configured" };
    }

    // 装了 App 的仓库可以推送；没装的公开仓库只读挂载。不使用仓库时不查 GitHub：没关联也能发起。
    let repo: { fullName: string; canPush: boolean; baseBranch: string } | undefined;
    if (input.repo !== undefined) {
      const { repo: wanted, baseBranch } = input;
      if (!baseBranch) return { ok: false, error: "branch_not_found" };
      const checked = await withGitHubToken(this.#deps, userId, async (token) => {
        const found =
          (await github.listInstalledRepos(token)).find((r) => sameName(r.fullName, wanted)) ??
          (await github.getPublicRepo(token, wanted));
        if (!found) return "repo_not_found" as const;
        const branches = await github.listBranches(token, found.fullName);
        if (!branches.includes(baseBranch)) return "branch_not_found" as const;
        return found;
      });
      if (checked === "not_connected") return { ok: false, error: "github_not_connected" };
      if (typeof checked === "string") return { ok: false, error: checked };
      repo = { fullName: checked.fullName, canPush: checked.canPush, baseBranch };
    }

    const now = clock.now();
    const text = input.text.trim();
    const created = await this.#withNewShortId((shortId) =>
      db.transaction(async (tx) => {
        const [session] = await tx
          .insert(sessions)
          .values({
            shortId,
            userId,
            title: titleFrom(text),
            status: "queued",
            environmentId,
            model: model.ref,
            effort,
            createdAt: now,
            updatedAt: now,
            sortKey: now.getTime(),
          })
          .returning();
        const id = (session as SessionRow).id;
        if (repo) {
          await tx.insert(sessionRepos).values({
            sessionId: id,
            position: 0,
            fullName: repo.fullName,
            baseBranch: repo.baseBranch,
            branch: sessionBranch(shortId),
            access: repo.canPush ? "push" : "read",
          });
        }
        await tx
          .insert(turns)
          .values({ sessionId: id, number: 1, input: text, status: "running", startedAt: now });
        await this.#append(tx, id, 1, { type: "user.message", text });
        await this.#append(tx, id, 1, { type: "status", status: "queued", detail: null });
        return session as SessionRow;
      }),
    );
    this.#notify(created);
    await this.#dispatch(created.id);
    return { ok: true, value: (await this.#view(created.id)) as Session };
  }

  /**
   * 最近有动静的 200 个，加上所有置顶的和分组里的（再久没动也要在侧栏里），最近有动静的在前。
   * 侧栏自己按 pinnedAt、groupId、sortKey 分类排序。
   */
  async list(userId: string): Promise<Session[]> {
    const { db } = this.#deps;
    const recent = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.updatedAt))
      .limit(LIST_LIMIT);
    const rows =
      recent.length < LIST_LIMIT
        ? recent
        : [
            ...recent,
            ...(await db
              .select()
              .from(sessions)
              .where(
                and(
                  eq(sessions.userId, userId),
                  or(isNotNull(sessions.pinnedAt), isNotNull(sessions.groupId)),
                  notInArray(
                    sessions.id,
                    recent.map((r) => r.id),
                  ),
                ),
              )
              .orderBy(desc(sessions.updatedAt))),
          ];
    return this.#views(rows);
  }

  async get(userId: string, shortId: string): Promise<Session | undefined> {
    const row = await this.#find(userId, shortId);
    return row && (await this.#views([row]))[0];
  }

  async open(userId: string, shortId: string): Promise<SessionHandle | undefined> {
    const row = await this.#find(userId, shortId);
    if (!row) return undefined;
    return {
      session: (await this.#views([row]))[0] as Session,
      eventsAfter: (seq) => this.#eventsAfter(row.id, seq),
      subscribe: (listener) => this.#events.on(row.id, listener),
      subscribeLive: (listener) => this.#live.on(row.id, listener),
    };
  }

  /** 改名。标题不动"最近有动静"的时间，改了名的会话不会跳到列表最上面。 */
  async rename(userId: string, shortId: string, title: string): Promise<Result<Session>> {
    const [row] = await this.#deps.db
      .update(sessions)
      .set({ title })
      .where(and(eq(sessions.userId, userId), eq(sessions.shortId, shortId)))
      .returning();
    if (!row) return { ok: false, error: "session_not_found" };
    this.#changes.emit(userId, shortId);
    return { ok: true, value: (await this.#views([row]))[0] as Session };
  }

  /**
   * 置顶或取消置顶。和改名一样不动"最近有动静"的时间；已归档的会话不能置顶（归档时自动取消置顶）。
   * 已经置顶的再置顶一次不变，置顶时间还是原来的。
   */
  async setPinned(userId: string, shortId: string, pinned: boolean): Promise<Result<Session>> {
    const done = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return "session_not_found" as const;
      if (pinned && session.status === "archived") return "session_archived" as const;
      if (pinned === (session.pinnedAt !== null)) return session;
      const now = this.#deps.clock.now();
      // 置顶：放在置顶的最上面（后置顶的在前），离开分组；取消置顶：回到"最近"，按最近有动静的时间排
      const [row] = await tx
        .update(sessions)
        .set(
          pinned
            ? {
                pinnedAt: now,
                groupId: null,
                sortKey: await this.sidebar.pinKey(tx, userId, session.id, now),
              }
            : { pinnedAt: null, sortKey: naturalKey },
        )
        .where(eq(sessions.id, session.id))
        .returning();
      return row as SessionRow;
    });
    if (typeof done === "string") return { ok: false, error: done };
    this.#changes.emit(userId, shortId);
    return { ok: true, value: (await this.#views([done]))[0] as Session };
  }

  /** 标为已读或未读（打开会话时浏览器标已读；菜单里能手动标未读）。不动"最近有动静"的时间。 */
  async setUnread(userId: string, shortId: string, unread: boolean): Promise<Result<Session>> {
    const [row] = await this.#deps.db
      .update(sessions)
      .set({ unread })
      .where(and(eq(sessions.userId, userId), eq(sessions.shortId, shortId)))
      .returning();
    if (!row) return { ok: false, error: "session_not_found" };
    this.#changes.emit(userId, shortId);
    return { ok: true, value: (await this.#views([row]))[0] as Session };
  }

  /** 回合结束或会话失败时：没人开着这个会话（没有打开的事件流）就标成有新内容。 */
  async #markUnreadIfAway(tx: Tx, sessionId: string): Promise<void> {
    if (this.#events.count(sessionId) > 0) return;
    await tx.update(sessions).set({ unread: true }).where(eq(sessions.id, sessionId));
  }

  /** 会话分支对比基础分支的改动（改动面板，#27），按会话的仓库顺序。还没有的仓库不在里面。 */
  async listDiffs(userId: string, shortId: string): Promise<Result<RepoDiff[]>> {
    const [session] = await this.#deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.shortId, shortId)));
    if (!session) return { ok: false, error: "session_not_found" };
    const rows = await this.#deps.db
      .select({ repo: workspaceDiffs.repo, body: workspaceDiffs.body })
      .from(workspaceDiffs)
      .where(eq(workspaceDiffs.sessionId, session.id));
    const order = (
      await this.#deps.db
        .select({ fullName: sessionRepos.fullName })
        .from(sessionRepos)
        .where(eq(sessionRepos.sessionId, session.id))
        .orderBy(asc(sessionRepos.position))
    ).map((r) => r.fullName);
    return {
      ok: true,
      value: rows
        .filter((row) => order.includes(row.repo))
        .sort((a, b) => order.indexOf(a.repo) - order.indexOf(b.repo))
        .map((row) => row.body),
    };
  }

  /** 宿主机发来的 diff：每个仓库只留最新的（补发来的旧回合的不盖新的）。不是这个会话的回合的不收。 */
  async #storeDiff(event: Extract<HostEvent, { type: "workspace.diff" }>): Promise<void> {
    if (!UUID.test(event.turnId) || !UUID.test(event.sessionId)) return;
    const [turn] = await this.#deps.db
      .select({ number: turns.number })
      .from(turns)
      .where(and(eq(turns.id, event.turnId), eq(turns.sessionId, event.sessionId)));
    if (!turn) return;
    for (const repo of event.repos) {
      await this.#deps.db
        .insert(workspaceDiffs)
        .values({
          sessionId: event.sessionId,
          repo: repo.fullName,
          turn: turn.number,
          body: repo,
          updatedAt: this.#deps.clock.now(),
        })
        .onConflictDoUpdate({
          target: [workspaceDiffs.sessionId, workspaceDiffs.repo],
          set: {
            turn: sql`excluded.turn`,
            body: sql`excluded.body`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`excluded.turn >= ${workspaceDiffs.turn}`,
        });
    }
  }

  /** 宿主机发来的 Agent 会话文件：是这个会话的回合发来的才存（agent-archive.ts）。 */
  async #storeArchive(event: Extract<HostEvent, { type: "agent.archive" }>): Promise<void> {
    if (!UUID.test(event.turnId) || !UUID.test(event.sessionId)) return;
    const [turn] = await this.#deps.db
      .select({ id: turns.id })
      .from(turns)
      .where(and(eq(turns.id, event.turnId), eq(turns.sessionId, event.sessionId)));
    if (!turn) return;
    await saveAgentArchive(this.#deps, event.sessionId, event.data);
  }

  /** 会话里置顶的消息，按在会话里的先后排。 */
  async listPins(userId: string, shortId: string): Promise<Result<MessagePin[]>> {
    const [session] = await this.#deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.shortId, shortId)));
    if (!session) return { ok: false, error: "session_not_found" };
    return { ok: true, value: await this.#pins(session.id) };
  }

  /**
   * 置顶或取消置顶一条 Agent 回复（seq 是它的事件序号）。置顶时给它取一个短标题（pin-title.ts）：
   * 用这个回合里到这条为止的回复，先问模型，模型给不出来用规则。重复置顶不变。返回置顶后的整个列表。
   */
  async setMessagePin(
    userId: string,
    shortId: string,
    seq: number,
    pinned: boolean,
  ): Promise<Result<MessagePin[]>> {
    // 模型要几秒：在事务外问，不拿着会话的锁等
    const asked = pinned ? await this.#askPinTitle(userId, shortId, seq) : undefined;
    const done = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return "session_not_found" as const;
      if (!pinned) {
        await tx
          .delete(messagePins)
          .where(and(eq(messagePins.sessionId, session.id), eq(messagePins.seq, seq)));
        return session;
      }
      const [target] = await tx
        .select()
        .from(sessionEvents)
        .where(and(eq(sessionEvents.sessionId, session.id), eq(sessionEvents.seq, seq)));
      if (target?.body.type !== "message") return "message_not_found" as const;
      const texts = await this.#repliesUpTo(tx, session.id, target.turn, seq);
      await tx
        .insert(messagePins)
        .values({
          sessionId: session.id,
          seq,
          title: asked ?? pinTitle(texts),
          createdAt: this.#deps.clock.now(),
        })
        .onConflictDoNothing();
      return session;
    });
    if (typeof done === "string") return { ok: false, error: done };
    return { ok: true, value: await this.#pins(done.id) };
  }

  /** 这个回合里到 seq 为止的 Agent 回复，按顺序。 */
  async #repliesUpTo(db: Database | Tx, sessionId: string, turn: number | null, seq: number) {
    const replies = await db
      .select({ body: sessionEvents.body })
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          turn === null ? sql`${sessionEvents.turn} is null` : eq(sessionEvents.turn, turn),
          sql`${sessionEvents.seq} <= ${seq}`,
        ),
      )
      .orderBy(asc(sessionEvents.seq));
    return replies.flatMap((r) => (r.body.type === "message" ? [r.body.text] : []));
  }

  /** 问模型给要置顶的回复起短标题。已经置顶了、找不到这条回复、模型给不出来：undefined。 */
  async #askPinTitle(userId: string, shortId: string, seq: number): Promise<string | undefined> {
    const titles = this.#pinTitles;
    if (!titles) return undefined;
    const [session] = await this.#deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.shortId, shortId)));
    if (!session) return undefined;
    const [pinnedAlready] = await this.#deps.db
      .select({ seq: messagePins.seq })
      .from(messagePins)
      .where(and(eq(messagePins.sessionId, session.id), eq(messagePins.seq, seq)));
    if (pinnedAlready) return undefined;
    const [target] = await this.#deps.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, session.id), eq(sessionEvents.seq, seq)));
    if (target?.body.type !== "message") return undefined;
    const texts = await this.#repliesUpTo(this.#deps.db, session.id, target.turn, seq);
    return titles.title({ userId, sessionId: session.id, texts });
  }

  async #pins(sessionId: string): Promise<MessagePin[]> {
    const rows = await this.#deps.db
      .select()
      .from(messagePins)
      .where(eq(messagePins.sessionId, sessionId))
      .orderBy(asc(messagePins.seq));
    return rows.map((r) => ({ seq: r.seq, title: r.title, createdAt: r.createdAt.toISOString() }));
  }

  /**
   * 归档：正在跑的回合停下，沙箱删掉，会话不再接收消息。已经归档的再归档一次什么都不做。
   * 排队的消息留着，取消归档以后发消息唤醒时一起处理。
   */
  async archive(userId: string, shortId: string): Promise<Result<Session>> {
    const done = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return undefined;
      if (session.status === "archived") return { session, changed: false };
      const number = await this.#stopRunningTurn(tx, session.id);
      await this.#setStatus(tx, session.id, number, { status: "archived", detail: null });
      // 归档的会话收在列表最下面的一组里，不再留在置顶和分组里
      await tx
        .update(sessions)
        .set({ pinnedAt: null, groupId: null, sortKey: naturalKey })
        .where(eq(sessions.id, session.id));
      return { session, changed: true };
    });
    if (!done) return { ok: false, error: "session_not_found" };
    if (done.changed) {
      this.#notify(done.session);
      this.#send({ type: "destroy_sandbox", sessionId: done.session.id });
    }
    return { ok: true, value: (await this.#view(done.session.id)) as Session };
  }

  /** 取消归档：回到休眠，发消息就唤醒。没归档的会话不动。 */
  async unarchive(userId: string, shortId: string): Promise<Result<Session>> {
    const done = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return undefined;
      if (session.status !== "archived") return { session, changed: false };
      await this.#setStatus(tx, session.id, null, { status: "dormant", detail: null });
      return { session, changed: true };
    });
    if (!done) return { ok: false, error: "session_not_found" };
    if (done.changed) this.#notify(done.session);
    return { ok: true, value: (await this.#view(done.session.id)) as Session };
  }

  /** 删除：会话的事件、回合、排队的消息一起删掉，沙箱删掉。GitHub 上的分支和 PR 不动。 */
  async remove(userId: string, shortId: string): Promise<Result<void>> {
    const session = await this.#deps.db.transaction(async (tx) => {
      const row = await this.#lockOwn(tx, userId, shortId);
      if (row) await tx.delete(sessions).where(eq(sessions.id, row.id));
      return row;
    });
    if (!session) return { ok: false, error: "session_not_found" };
    this.#notify(session);
    this.#send({ type: "destroy_sandbox", sessionId: session.id });
    await removeAgentArchive(this.#deps, session.id);
    return { ok: true, value: undefined };
  }

  /** 把正在跑的回合记成"已停止"，返回它的序号；没有正在跑的回合时返回 null。 */
  async #stopRunningTurn(tx: Tx, sessionId: string): Promise<number | null> {
    const [turn] = await tx
      .update(turns)
      .set({ status: "stopped", endedAt: this.#deps.clock.now() })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "running")))
      .returning({ number: turns.number });
    if (!turn) return null;
    await this.#append(tx, sessionId, turn.number, { type: "turn.ended", reason: "stopped" });
    return turn.number;
  }

  /**
   * 把一条消息插进正在跑的回合：Agent 在下一步读到（插话）。沙箱还在准备、回合还没真正开始时，
   * 直接并进这个回合的输入。queued 是它由哪几条排队的消息变来的（界面上把那几条换成这一条）。
   * 返回要发给宿主机的命令；没有正在跑的回合时返回 "no_turn"。
   */
  async #injectIntoRunning(
    tx: Tx,
    session: SessionRow,
    text: string,
    queued: string[],
  ): Promise<HostCommand | undefined | "no_turn"> {
    const [turn] = await tx
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, session.id), eq(turns.status, "running")))
      .orderBy(desc(turns.number))
      .limit(1);
    if (!turn) return "no_turn";
    await this.#append(tx, session.id, turn.number, {
      type: "user.message",
      text,
      injected: true,
      ...(queued.length > 0 ? { queued } : {}),
    });
    if (session.statusDetail === "preparing_sandbox" || session.status === "queued") {
      await tx
        .update(turns)
        .set({ input: `${turn.input}\n\n${text}` })
        .where(eq(turns.id, turn.id));
      return undefined;
    }
    return { type: "inject_message", sessionId: session.id, turnId: turn.id, text };
  }

  /**
   * 停止：停下正在跑的回合（照 Claude，输入框里的字不动）。回合马上记成已停止，再让宿主机停下；
   * 之后这个回合的事件都忽略。还有"稍后排队"的消息时，照 2026-11-14 的决定用它们开始下一个回合。
   */
  async stopTurn(userId: string, shortId: string): Promise<Result<void>> {
    const outcome = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return "session_not_found" as const;
      const [turn] = await tx
        .select({ id: turns.id })
        .from(turns)
        .where(and(eq(turns.sessionId, session.id), eq(turns.status, "running")))
        .limit(1);
      if (!turn || (session.status !== "running" && session.status !== "queued")) {
        return "nothing_running" as const;
      }
      const number = await this.#stopRunningTurn(tx, session.id);
      const stop: HostCommand = { type: "stop_turn", sessionId: session.id, turnId: turn.id };
      const next = await this.#startQueued(tx, session);
      if (!next) await this.#setStatus(tx, session.id, number, { status: "waiting", detail: null });
      return { session, stop, next };
    });
    if (typeof outcome === "string") return { ok: false, error: outcome };
    this.#notify(outcome.session);
    this.#send(outcome.stop);
    if (outcome.next) this.#send(outcome.next);
    else this.#judgeLater(outcome.session.id, outcome.stop.turnId);
    return { ok: true, value: undefined };
  }

  /** 订阅这个用户的会话列表变化：listener 收到变了的会话的短 ID。 */
  /** 侧栏的分组有变化（建、改名、删）。 */
  subscribeGroups(userId: string, listener: () => void): () => void {
    return this.#groupChanges.on(userId, listener);
  }

  subscribeChanges(userId: string, listener: (shortId: string) => void): () => void {
    return this.#changes.on(userId, listener);
  }

  /**
   * 用户在等待回复的会话里发消息，开始下一个回合。
   * 可以顺便换模型或思考强度，从这个回合起生效。
   */
  /**
   * 发消息。会话在等待回复：开始下一个回合。Agent 还在工作（或者在排队等空位）：先排队，
   * 回合结束后合成下一回合的开头；排队的消息处理之前可以撤回或立即发送。
   * 休眠或失败的会话：重新准备沙箱，好了再开始回合。只有已归档的会话不能发。
   */
  async sendMessage(
    userId: string,
    shortId: string,
    message: {
      text: string;
      model?: string;
      effort?: ThinkingEffort;
      /**
       * Agent 在工作时：now 直接插进当前回合（Agent 下一步读到），later 排队到回合结束。
       * 换了模型或思考强度时总是排队（要到下一个回合才生效）。会话没在工作时两个都一样。
       */
      mode?: "now" | "later";
    },
  ): Promise<Result<SendOutcome>> {
    const body = message.text.trim();
    if (message.model !== undefined) {
      const model = await this.#models.find(normalizeModelRef(message.model));
      if (!model) return { ok: false, error: "model_not_found" };
      // 只换了模型：思考强度换成新模型支持的（设置里的默认值，或者最近的一档）
      const effort = chooseEffort(
        model.efforts,
        message.effort,
        await readSetting(this.#deps, "default_effort", { userId }),
      );
      if (!effort) return { ok: false, error: "model_not_found" };
      Object.assign(message, { model: model.ref, effort });
    }
    const outcome = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return "session_not_found" as const;
      // 会话的模型没了（提供方删了、停用了、key 删了）：提示换一个，不等沙箱里调模型才失败
      if (
        message.model === undefined &&
        session.status !== "archived" &&
        !(await this.#models.find(session.model))
      ) {
        return "model_gone" as const;
      }
      if (session.status === "waiting") {
        const command = await this.#startTurn(tx, session, { ...message, text: body });
        return { kind: "started" as const, session, command };
      }
      if (session.status === "running" || session.status === "queued") {
        const switching = message.model !== undefined || message.effort !== undefined;
        if (message.mode === "now" && !switching) {
          const injected = await this.#injectIntoRunning(tx, session, body, []);
          if (injected !== "no_turn") {
            return { kind: "injected" as const, session, command: injected };
          }
        }
        const queued = await this.#enqueue(tx, session, { ...message, text: body });
        return { kind: "queued" as const, session, queued };
      }
      if (session.status === "dormant" || session.status === "failed") {
        // 休眠的会话没有沙箱，失败的会话沙箱出了错（2026-11-15 用户定的：失败以后也能接着发）：
        // 消息先排队，会话回到排队中去重新准备沙箱，沙箱好了再合成回合。
        const queued = await this.#enqueue(tx, session, { ...message, text: body });
        await this.#setStatus(tx, session.id, null, { status: "queued", detail: null });
        return { kind: "woken" as const, session, queued };
      }
      return "session_closed" as const;
    });
    if (typeof outcome === "string") return { ok: false, error: outcome };
    this.#notify(outcome.session);
    if (outcome.kind === "woken") {
      await this.#dispatch(outcome.session.id);
      return { ok: true, value: { queued: outcome.queued } };
    }
    if (outcome.kind === "queued") return { ok: true, value: { queued: outcome.queued } };
    if (outcome.kind === "injected") {
      if (outcome.command) this.#send(outcome.command);
      return { ok: true, value: { injected: true } };
    }
    this.#send(outcome.command);
    return { ok: true, value: { started: (await this.#view(outcome.session.id)) as Session } };
  }

  /** 撤回一条排队的消息，返回原文（浏览器放回输入框）。 */
  async withdrawQueued(userId: string, shortId: string, queueId: string): Promise<Result<string>> {
    if (!UUID.test(queueId)) return { ok: false, error: "queued_not_found" };
    const outcome = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return "session_not_found" as const;
      const [row] = await tx
        .delete(queuedMessages)
        .where(and(eq(queuedMessages.id, queueId), eq(queuedMessages.sessionId, session.id)))
        .returning({ text: queuedMessages.text });
      if (!row) return "queued_not_found" as const;
      await this.#append(tx, session.id, null, { type: "message.withdrawn", id: queueId });
      return { session, text: row.text };
    });
    if (typeof outcome === "string") return { ok: false, error: outcome };
    this.#notify(outcome.session);
    return { ok: true, value: outcome.text };
  }

  /**
   * 排队的消息"立即发送"：Agent 在当前回合的下一步读到它（插话）。
   * 沙箱还在准备、回合还没真正开始：直接并进这个回合的输入。回合已经停了：用它开始下一个回合。
   * 会话休眠或失败（失败前留下的排队消息）：和发消息一样重新准备沙箱，好了再合成回合。
   * 已经在重新准备沙箱、已归档：消息留在队里不动（归档的报"会话已归档"）。
   */
  async sendQueuedNow(userId: string, shortId: string, queueId: string): Promise<Result<void>> {
    if (!UUID.test(queueId)) return { ok: false, error: "queued_not_found" };
    const outcome = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return "session_not_found" as const;
      const [turn] = await tx
        .select()
        .from(turns)
        .where(and(eq(turns.sessionId, session.id), eq(turns.status, "running")))
        .orderBy(desc(turns.number))
        .limit(1);
      // 没有回合可以插话，也不能马上开始回合：消息留在队里，不能删。
      // 休眠或失败的去重新准备沙箱；已经在重新准备的（没有等着的回合）沙箱好了自然会合成回合；已归档的不能发。
      if (session.status !== "waiting" && !turn) {
        const [kept] = await tx
          .select({ id: queuedMessages.id })
          .from(queuedMessages)
          .where(and(eq(queuedMessages.id, queueId), eq(queuedMessages.sessionId, session.id)));
        if (!kept) return "queued_not_found" as const;
        if (session.status === "archived") return "session_closed" as const;
        if (session.status !== "dormant" && session.status !== "failed") {
          return { session, command: undefined };
        }
        await this.#setStatus(tx, session.id, null, { status: "queued", detail: null });
        return { session, command: undefined, wake: true };
      }
      const [row] = await tx
        .delete(queuedMessages)
        .where(and(eq(queuedMessages.id, queueId), eq(queuedMessages.sessionId, session.id)))
        .returning();
      if (!row) return "queued_not_found" as const;
      const queued = {
        text: row.text,
        model: row.model ?? undefined,
        effort: row.effort ?? undefined,
      };
      if (session.status === "waiting" || !turn) {
        return {
          session,
          command: await this.#startTurn(tx, session, { ...queued, queued: [row.id] }),
        };
      }
      const injected = await this.#injectIntoRunning(tx, session, row.text, [row.id]);
      if (injected === "no_turn") return "session_closed" as const;
      return { session, command: injected };
    });
    if (typeof outcome === "string") return { ok: false, error: outcome };
    this.#notify(outcome.session);
    if ("wake" in outcome) await this.#dispatch(outcome.session.id);
    else if (outcome.command) this.#send(outcome.command);
    return { ok: true, value: undefined };
  }

  /**
   * GitHub 说某个分支上的 PR 变了（pull_request webhook）：如果是会话分支，记下 PR 编号和状态，
   * 侧边栏和会话页跟着更新。
   * - 一个分支上可能先后开过几个 PR（关掉一个再开一个）：显示编号最大的那个，旧 PR 后来再有变化也不换回去；
   * - 同一个 PR 的 webhook 可能乱序到达：只接受比已记下的更新的。
   */
  async updatePullRequest(pr: {
    repo: string;
    branch: string;
    number: number;
    state: PullRequestState;
    updatedAt: Date;
  }): Promise<void> {
    if (!pr.branch.startsWith("seekcloud/")) return;
    const updated = await this.#deps.db
      .update(sessionRepos)
      .set({ prNumber: pr.number, prState: pr.state, prUpdatedAt: pr.updatedAt })
      .where(
        and(
          sql`lower(${sessionRepos.fullName}) = ${pr.repo.toLowerCase()}`,
          eq(sessionRepos.branch, pr.branch),
          sql`(${sessionRepos.prNumber} is null or ${sessionRepos.prNumber} < ${pr.number}
            or (${sessionRepos.prNumber} = ${pr.number} and ${sessionRepos.prUpdatedAt} <= ${pr.updatedAt}))`,
        ),
      )
      .returning({ sessionId: sessionRepos.sessionId });
    if (updated.length === 0) return;
    const rows = await this.#deps.db
      .select()
      .from(sessions)
      .where(
        inArray(
          sessions.id,
          updated.map((u) => u.sessionId),
        ),
      );
    for (const session of rows) this.#notify(session);
  }

  /** 锁住这个用户自己的会话这一行。 */
  async #lockOwn(tx: Tx, userId: string, shortId: string): Promise<SessionRow | undefined> {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.shortId, shortId)))
      .for("update");
    return session;
  }

  /** 在会话这一行的锁里开始下一个回合。返回"开始回合"的命令，事务提交后再发给宿主机。 */
  async #startTurn(
    tx: Tx,
    session: SessionRow,
    input: {
      text: string;
      model?: string;
      effort?: ThinkingEffort;
      queued?: string[];
      followUp?: "push_failed";
    },
  ): Promise<HostCommand> {
    const [last] = await tx
      .select({ number: turns.number })
      .from(turns)
      .where(eq(turns.sessionId, session.id))
      .orderBy(desc(turns.number))
      .limit(1);
    const number = (last?.number ?? 0) + 1;
    const model = input.model ?? session.model;
    const effort = input.effort ?? session.effort;
    if (model !== session.model || effort !== session.effort) {
      await tx.update(sessions).set({ model, effort }).where(eq(sessions.id, session.id));
      await this.#append(tx, session.id, number, { type: "model.changed", model, effort });
    }
    const [turn] = await tx
      .insert(turns)
      .values({
        sessionId: session.id,
        number,
        input: input.text,
        status: "running",
        startedAt: this.#deps.clock.now(),
      })
      .returning({ id: turns.id });
    await this.#append(tx, session.id, number, {
      type: "user.message",
      text: input.text,
      ...(input.queued && { queued: input.queued }),
      ...(input.followUp && { followUp: input.followUp }),
    });
    await this.#setStatus(tx, session.id, number, { status: "running", detail: null });
    return {
      type: "start_turn",
      sessionId: session.id,
      turnId: (turn as { id: string }).id,
      text: input.text,
      ...splitModel(model),
      effort,
      firstTurn: !(await this.#reachedAgent(tx, session.id)),
      turnNumber: number,
    };
  }

  /** 这个会话以前有没有哪个回合到过 Agent（有过 turn.started）：没有的话，Agent 那边还没有这个会话。 */
  async #reachedAgent(tx: Tx, sessionId: string): Promise<boolean> {
    const [row] = await tx
      .select({ seq: sessionEvents.seq })
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          sql`${sessionEvents.body}->>'type' = 'turn.started'`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** 回合结束后，排队的消息合成下一回合的开头。没有排队的消息时返回 undefined。 */
  async #startQueued(tx: Tx, session: SessionRow): Promise<HostCommand | undefined> {
    const rows = await tx
      .delete(queuedMessages)
      .where(eq(queuedMessages.sessionId, session.id))
      .returning();
    if (rows.length === 0) return undefined;
    rows.sort((a, b) => a.seq - b.seq);
    const chosen = rows.findLast((row) => row.model || row.effort);
    return this.#startTurn(tx, session, {
      text: rows.map((row) => row.text).join("\n\n"),
      model: chosen?.model ?? undefined,
      effort: chosen?.effort ?? undefined,
      queued: rows.map((row) => row.id),
    });
  }

  /**
   * 宿主机上报的事件。每个事件在会话这一行的锁里处理，和用户发消息互不干扰。
   * 宿主机断线重连后会补发，所以同一个事件可能来两次，也可能来得晚：
   * 只接受当前状态下说得通的事件，其余忽略（比如已经结束的回合又来的事件、已经不在了的会话）。
   */
  async handleHostEvent(event: HostEvent): Promise<void> {
    if (event.type === "progress" || event.type === "delta") {
      await this.#forwardLive(event);
      return;
    }
    if (event.type === "workspace.diff") {
      await this.#storeDiff(event);
      return;
    }
    if (event.type === "agent.archive") {
      await this.#storeArchive(event);
      return;
    }
    const handled = await this.#deps.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, event.sessionId))
        .for("update");
      if (!session) return undefined;
      let next: HostCommand | undefined;
      if (event.type === "sandbox.ready") next = await this.#sandboxReady(tx, session);
      else if (event.type === "sandbox.failed")
        await this.#sandboxFailed(tx, session, toSafeError(event.error));
      else next = await this.#agentEvent(tx, session, event.turnId, event.event);
      return { session, next };
    });
    if (!handled) return;
    this.#notify(handled.session);
    // 事务提交之后再发命令，免得宿主机回得太快、读到还没提交的状态。
    if (handled.next) this.#send(handled.next);
    if (event.type === "agent" && event.event.type === "turn.ended") {
      this.#judgeLater(event.sessionId, event.turnId);
    }
  }

  /**
   * 回合结束以后判断"等你输入"还是"已完成"（#139，awaiting-input.ts）。在后台做：不拖住回合结束后的
   * 通知和下一条命令（#140 换成模型调用以后要一两秒）。判断完再核对一遍：会话还在等待回复、还没有附加说明、
   * 最新的回合就是这一个（这期间管理员发了消息就作废），再补一条状态事件。
   * 变成"等你输入"时发通知：多渠道通知（#102）做好以后在这里调。
   */
  #judgeLater(sessionId: string, turnId: string): void {
    const job = this.#judgeTurn(sessionId, turnId).catch((error) =>
      console.error(`会话 ${sessionId} 判断是否在等输入失败：${String(error)}`),
    );
    this.#judging.add(job);
    void job.finally(() => this.#judging.delete(job));
  }

  /** 等后台的判断都做完（测试用）。 */
  async settled(): Promise<void> {
    while (this.#judging.size > 0) await Promise.all([...this.#judging]);
  }

  async #judgeTurn(sessionId: string, turnId: string): Promise<void> {
    if (!UUID.test(turnId)) return;
    const [turn] = await this.#deps.db
      .select({ number: turns.number, status: turns.status })
      .from(turns)
      .where(and(eq(turns.id, turnId), eq(turns.sessionId, sessionId)));
    if (!turn || turn.status === "running") return;
    const [reply] = await this.#deps.db
      .select({ body: sessionEvents.body })
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          eq(sessionEvents.turn, turn.number),
          sql`${sessionEvents.body}->>'type' = 'message'`,
        ),
      )
      .orderBy(desc(sessionEvents.seq))
      .limit(1);
    const [owner] = await this.#deps.db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const check = this.#waitingCheck;
    const detail = await judgeTurnEnd({
      reason: turn.status,
      reply: reply?.body.type === "message" ? reply.body.text : "",
      ask:
        check && owner
          ? (text) => check.ask({ userId: owner.userId, sessionId, reply: text })
          : undefined,
    });
    const session = await this.#deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for("update");
      if (!row || row.status !== "waiting" || row.statusDetail !== null) return undefined;
      const [latest] = await tx
        .select({ number: turns.number })
        .from(turns)
        .where(eq(turns.sessionId, sessionId))
        .orderBy(desc(turns.number))
        .limit(1);
      if (latest?.number !== turn.number) return undefined;
      await this.#setStatus(tx, sessionId, turn.number, { status: "waiting", detail });
      // 补上附加说明不算新的动静：会话列表的排序和"多久以前"不变
      await tx
        .update(sessions)
        .set({ updatedAt: row.updatedAt, sortKey: row.sortKey })
        .where(eq(sessions.id, sessionId));
      return row;
    });
    if (session) this.#notify(session);
  }

  /** 模型进度、文字增量原样转给打开着这个会话的浏览器；不是正在跑的回合的（晚到的）丢掉。不落库。 */
  async #forwardLive(event: Extract<HostEvent, { type: "progress" | "delta" }>) {
    const [turn] = await this.#deps.db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.id, event.turnId),
          eq(turns.sessionId, event.sessionId),
          eq(turns.status, "running"),
        ),
      )
      .limit(1);
    if (!turn) return;
    this.#live.emit(
      event.sessionId,
      event.type === "progress"
        ? { event: "progress", data: { phase: event.phase, tokens: event.tokens } }
        : { event: "delta", data: { kind: event.kind, text: event.text } },
    );
  }

  /** 沙箱好了：开始正在等着的回合。返回要发给宿主机的命令。 */
  async #sandboxReady(tx: Tx, session: SessionRow): Promise<HostCommand | undefined> {
    if (session.status !== "running" || session.statusDetail !== "preparing_sandbox") return;
    const [turn] = await tx
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, session.id), eq(turns.status, "running")))
      .orderBy(desc(turns.number))
      .limit(1);
    if (!turn) {
      // 唤醒休眠的会话：没有等着的回合，把排队的消息合成一个；没有消息就等管理员说话。
      const next = await this.#startQueued(tx, session);
      if (!next) await this.#setStatus(tx, session.id, null, { status: "waiting", detail: null });
      return next;
    }
    await this.#setStatus(tx, session.id, turn.number, { status: "running", detail: null });
    return {
      type: "start_turn",
      sessionId: session.id,
      turnId: turn.id,
      text: turn.input,
      ...splitModel(session.model),
      effort: session.effort,
      firstTurn: !(await this.#reachedAgent(tx, session.id)),
      turnNumber: turn.number,
    };
  }

  /** 把一条消息排进队里，并记一条"已排队"的事件。 */
  async #enqueue(
    tx: Tx,
    session: SessionRow,
    message: { text: string; model?: string; effort?: ThinkingEffort },
  ): Promise<{ id: string; text: string }> {
    const [row] = await tx
      .insert(queuedMessages)
      .values({
        sessionId: session.id,
        text: message.text,
        model: message.model ?? null,
        effort: message.effort ?? null,
        createdAt: this.#deps.clock.now(),
      })
      .returning({ id: queuedMessages.id });
    const queued = { id: (row as { id: string }).id, text: message.text };
    await this.#append(tx, session.id, null, { type: "message.queued", ...queued });
    return queued;
  }

  async #sandboxFailed(tx: Tx, session: SessionRow, error: SafeError): Promise<void> {
    if (session.status === "failed" || session.status === "archived") return;
    const ended = await tx
      .update(turns)
      .set({ status: "failed", endedAt: this.#deps.clock.now() })
      .where(and(eq(turns.sessionId, session.id), eq(turns.status, "running")))
      .returning({ number: turns.number });
    await this.#setStatus(
      tx,
      session.id,
      ended[0]?.number ?? null,
      { status: "failed", detail: null },
      error,
    );
    await this.#markUnreadIfAway(tx, session.id);
  }

  /** Agent 事件只属于正在运行的回合；回合已经结束（包括重复的"回合结束"）就忽略。 */
  async #agentEvent(
    tx: Tx,
    session: SessionRow,
    turnId: string,
    event: AgentEvent,
  ): Promise<HostCommand | undefined> {
    const [turn] = await tx
      .select()
      .from(turns)
      .where(and(eq(turns.id, turnId), eq(turns.sessionId, session.id)));
    if (!turn) return;
    if (turn.status !== "running") {
      // 停止的回合：宿主机照样补提交、推送，整理工作区的结果在"已停止"之后才到，照样记下（改动卡片、检查点）
      if (
        event.type === "workspace" &&
        turn.status === "stopped" &&
        !(await this.#workspaceOf(tx, session.id, turn.number))
      ) {
        await this.#append(tx, session.id, turn.number, event);
      }
      return;
    }
    await this.#append(
      tx,
      session.id,
      turn.number,
      event.type === "turn.ended" && event.error !== undefined
        ? { ...event, error: toSafeError(event.error) }
        : event,
    );
    if (event.type !== "turn.ended") return undefined;
    await tx
      .update(turns)
      .set({ status: event.reason, endedAt: this.#deps.clock.now() })
      .where(eq(turns.id, turn.id));
    await this.#markUnreadIfAway(tx, session.id);
    // 推送失败：先自动跟进，把错误交给 Agent；管理员排队的消息等跟进回合结束再处理
    if (event.reason === "completed") {
      const followUp = await this.#pushFollowUp(tx, session, turn.number);
      if (followUp) return followUp;
    }
    // 有排队的消息就直接开始下一个回合。
    const next = await this.#startQueued(tx, session);
    if (next) return next;
    await this.#setStatus(tx, session.id, turn.number, { status: "waiting", detail: null });
    return undefined;
  }

  /** 这个回合整理工作区的结果（宿主机在回合结束时发的 workspace 事件）。 */
  async #workspaceOf(
    tx: Tx,
    sessionId: string,
    turn: number,
  ): Promise<Extract<SessionEventBody, { type: "workspace" }> | undefined> {
    const [row] = await tx
      .select({ body: sessionEvents.body })
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          eq(sessionEvents.turn, turn),
          sql`${sessionEvents.body}->>'type' = 'workspace'`,
        ),
      )
      .orderBy(desc(sessionEvents.seq))
      .limit(1);
    return row?.body as Extract<SessionEventBody, { type: "workspace" }> | undefined;
  }

  /**
   * 回合结束时有仓库推送失败：开一个跟进回合，把 git 的原话交给 Agent（#27）。同一条管理员消息最多跟进
   * MAX_PUSH_FOLLOW_UPS 次（从最近往前数连着的跟进回合），之后不再跟进，在会话里告诉管理员。
   */
  async #pushFollowUp(tx: Tx, session: SessionRow, turn: number): Promise<HostCommand | undefined> {
    const failed = (await this.#workspaceOf(tx, session.id, turn))?.repos.filter(
      (repo) => repo.push === "failed",
    );
    if (!failed?.length) return undefined;
    const recent = await tx
      .select({ body: sessionEvents.body })
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, session.id),
          sql`${sessionEvents.body}->>'type' = 'user.message'`,
        ),
      )
      .orderBy(desc(sessionEvents.seq))
      .limit(MAX_PUSH_FOLLOW_UPS + 1);
    let followUps = 0;
    for (const { body } of recent) {
      if (body.type !== "user.message" || !body.followUp) break;
      followUps++;
    }
    if (followUps >= MAX_PUSH_FOLLOW_UPS) {
      await this.#append(tx, session.id, turn, {
        type: "push.gave_up",
        repos: failed.map((repo) => repo.fullName),
      });
      return undefined;
    }
    return this.#startTurn(tx, session, {
      text: [
        "回合结束时推送会话分支失败。请找出原因并处理（比如先拉取远端的提交再合并），处理完提交即可，回合结束时平台会再推送一次。",
        "",
        ...failed.map((repo) => `- ${repo.fullName}：${repo.error ?? "推送失败"}`),
      ].join("\n"),
      followUp: "push_failed",
    });
  }

  /** 有宿主机能接新会话了：把排队中的会话按先来后到派出去。 */
  async dispatchQueued(): Promise<void> {
    const queued = await this.#deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.status, "queued"))
      .orderBy(sessions.createdAt);
    for (const { id } of queued) await this.#dispatch(id);
  }

  /** 交给宿主机准备沙箱。还没有能接新会话的宿主机时，会话留在排队中，等有了再派（dispatchQueued）。 */
  async #dispatch(sessionId: string): Promise<void> {
    const host = this.#deps.host;
    if (!host?.available()) return;
    const session = await this.#deps.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for("update");
      // 同一个会话可能被派两次（发起会话的同时一台宿主机连上来）：只有还在排队中的才派。
      if (current?.status !== "queued") return undefined;
      // 新会话有一个等着的回合（第 1 个）；唤醒休眠或失败的会话时没有，状态事件不挂在哪个回合上。
      const [turn] = await tx
        .select({ number: turns.number })
        .from(turns)
        .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "running")))
        .orderBy(desc(turns.number))
        .limit(1);
      await this.#setStatus(tx, sessionId, turn?.number ?? null, {
        status: "running",
        detail: "preparing_sandbox",
      });
      const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId));
      return row as SessionRow;
    });
    if (!session) return;
    this.#notify(session);
    this.#send({
      type: "prepare_sandbox",
      sessionId,
      repos: await this.#repos(sessionId),
      // 刚建的会话一定有环境。
      environmentId: session.environmentId as string,
      ...splitModel(session.model),
      effort: session.effort,
      aiLabels: await readSetting(this.#deps, "ai_labels", { userId: session.userId }),
      committer: await this.#committer(session.userId),
      providers: await this.#models.sandboxProviders(),
      agentArchive: await readAgentArchive(this.#deps, sessionId),
    });
  }

  /**
   * 发命令给宿主机。Git 代理要用户的 GitHub 令牌（ADR 0003，只放在宿主机的内存里），所以准备沙箱、
   * 开始回合之后各下发一份新鲜的（快过期的先刷新）：宿主机重启过、令牌过期了都能接上。
   * 令牌跟在命令后面发：宿主机收到准备沙箱才登记这个会话；回合开始以后 Agent 要过好几秒才用得上 git。
   */
  #send(command: HostCommand): void {
    this.#deps.host?.send(command);
    if (command.type === "prepare_sandbox" || command.type === "start_turn") {
      void this.#sendGitHubToken(command.sessionId).catch((error) =>
        console.warn(`会话 ${command.sessionId} 下发 GitHub 令牌失败`, error),
      );
    }
  }

  async #sendGitHubToken(sessionId: string): Promise<void> {
    const [row] = await this.#deps.db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!row) return;
    // 不使用仓库的会话（#191）：Git 代理、GitHub 工具都碰不到任何仓库，令牌用不上，不发
    if ((await this.#repos(sessionId)).length === 0) return;
    let token: string | undefined;
    try {
      token = await githubAccessToken(this.#deps, row.userId);
    } catch (error) {
      // 连不上 GitHub：公开仓库照样能克隆，推送会在宿主机那边失败并报给 Agent
      console.warn(`会话 ${sessionId} 取不到 GitHub 令牌`, error);
      return;
    }
    if (token) this.#deps.host?.send({ type: "set_github_token", sessionId, token });
  }

  /** 提交作者：管理员关联的 GitHub 账号（#27）。没关联、或者关联得早没存编号时为 undefined。 */
  async #committer(userId: string): Promise<Committer | undefined> {
    const [row] = await this.#deps.db
      .select({
        login: githubTokens.login,
        githubId: githubTokens.githubId,
        name: githubTokens.name,
      })
      .from(githubTokens)
      .where(eq(githubTokens.userId, userId));
    if (!row?.githubId) return undefined;
    return {
      name: row.name || row.login,
      email: `${row.githubId}+${row.login}@users.noreply.github.com`,
    };
  }

  /**
   * 管理员改了 AI 标识的开关：告诉宿主机上每个沙箱还开着的会话（运行中、等待回复），不用重开会话。
   * 排队中的会话在准备沙箱时带上新值；休眠的下次唤醒时带上。
   */
  async aiLabelsChanged(aiLabels: AiLabels): Promise<void> {
    const host = this.#deps.host;
    if (!host) return;
    const live = await this.#deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.status, ["running", "waiting"]));
    for (const { id } of live) this.#send({ type: "set_ai_labels", sessionId: id, aiLabels });
  }

  /**
   * 管理员改了模型提供方（#188）：沙箱还开着的会话（运行中、等待回复）换上新的配置，从下一个回合起生效。
   * 排队中的会话在准备沙箱时带上新的；休眠的下次唤醒时带上。
   */
  async modelsChanged(): Promise<void> {
    if (!this.#deps.host) return;
    const providers = await this.#models.sandboxProviders();
    const live = await this.#deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.status, ["running", "waiting"]));
    for (const { id } of live) this.#send({ type: "set_models", sessionId: id, providers });
  }

  /** 追加一条会话事件。在会话这一行上加锁取号，同一个会话的序号连续、不重复。 */
  async #append(tx: Tx, sessionId: string, turn: number | null, body: SessionEventBody) {
    const now = this.#deps.clock.now();
    const [row] = await tx
      .update(sessions)
      .set({
        lastSeq: sql`${sessions.lastSeq} + 1`,
        updatedAt: now,
        // 有新动静："最近"里的回到最上面；置顶和分组里的不动（#153）
        sortKey: sql`case when ${sessions.pinnedAt} is null and ${sessions.groupId} is null
          then ${now.getTime()}::double precision else ${sessions.sortKey} end`,
      })
      .where(eq(sessions.id, sessionId))
      .returning({ seq: sessions.lastSeq });
    await tx
      .insert(sessionEvents)
      .values({ sessionId, seq: (row as { seq: number }).seq, turn, body, createdAt: now });
  }

  /** 改状态，并记一条状态事件。失败时带上错误（已经过 toSafeError）。 */
  async #setStatus(
    tx: Tx,
    sessionId: string,
    turn: number | null,
    state: SessionState,
    error?: SafeError,
  ) {
    await tx
      .update(sessions)
      .set({ status: state.status, statusDetail: state.detail })
      .where(eq(sessions.id, sessionId));
    await this.#append(tx, sessionId, turn, {
      type: "status",
      ...state,
      ...(error === undefined ? {} : { error }),
    });
  }

  /** 事务提交之后调用：通知正在看这个会话的事件流和会话列表。 */
  #notify(session: SessionRow): void {
    this.#events.emit(session.id, undefined);
    this.#changes.emit(session.userId, session.shortId);
  }

  async #eventsAfter(sessionId: string, seq: number): Promise<SessionEvent[]> {
    const rows = await this.#deps.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, seq)))
      .orderBy(asc(sessionEvents.seq))
      .limit(EVENT_PAGE);
    return rows.map((r) => ({
      seq: r.seq,
      at: r.createdAt.toISOString(),
      turn: r.turn,
      ...r.body,
    }));
  }

  async #find(userId: string, shortId: string): Promise<SessionRow | undefined> {
    const [row] = await this.#deps.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.shortId, shortId)));
    return row;
  }

  async #view(sessionId: string): Promise<Session | undefined> {
    const rows = await this.#deps.db.select().from(sessions).where(eq(sessions.id, sessionId));
    return (await this.#views(rows))[0];
  }

  async #views(rows: SessionRow[]): Promise<Session[]> {
    if (rows.length === 0) return [];
    const repos = await this.#deps.db
      .select()
      .from(sessionRepos)
      .where(
        inArray(
          sessionRepos.sessionId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(sessionRepos.position));
    const environmentIds = [
      ...new Set(rows.flatMap((r) => (r.environmentId ? [r.environmentId] : []))),
    ];
    const environmentNames = new Map(
      environmentIds.length === 0
        ? []
        : (
            await this.#deps.db
              .select({ id: environments.id, name: environments.name })
              .from(environments)
              .where(inArray(environments.id, environmentIds))
          ).map((e) => [e.id, e.name]),
    );
    return rows.map((r) => ({
      shortId: r.shortId,
      title: r.title,
      status: r.status,
      detail: r.statusDetail,
      repos: repos
        .filter((repo) => repo.sessionId === r.id)
        .map((repo) => ({
          ...toSessionRepo(repo),
          pullRequest:
            repo.prNumber !== null && repo.prState !== null
              ? { number: repo.prNumber, state: repo.prState }
              : null,
        })),
      model: r.model,
      effort: r.effort,
      environmentName: (r.environmentId && environmentNames.get(r.environmentId)) || null,
      pinnedAt: r.pinnedAt?.toISOString() ?? null,
      groupId: r.groupId,
      sortKey: r.sortKey,
      unread: r.unread,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async #repos(sessionId: string): Promise<SessionRepo[]> {
    const rows = await this.#deps.db
      .select()
      .from(sessionRepos)
      .where(eq(sessionRepos.sessionId, sessionId))
      .orderBy(asc(sessionRepos.position));
    return rows.map(toSessionRepo);
  }

  async #environmentFor(userId: string, environmentId?: string): Promise<string | undefined> {
    const rows = await this.#deps.db
      .select({ id: environments.id, isDefault: environments.isDefault })
      .from(environments)
      .where(eq(environments.userId, userId));
    const match = environmentId
      ? rows.find((e) => e.id === environmentId)
      : rows.find((e) => e.isDefault);
    return match?.id;
  }

  /** 短 ID 撞上已有的（几乎不会发生）就换一个再试。 */
  async #withNewShortId<T>(insert: (shortId: string) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await insert(newShortId());
      } catch (error) {
        const duplicate =
          (error as { cause?: { constraint?: string } }).cause?.constraint ===
          "sessions_short_id_unique";
        if (!duplicate || attempt >= 3) throw error;
      }
    }
  }
}

/** "提供方/模型"；没有提供方的旧写法（#113 之前）补上 deepseek。 */
export function normalizeModelRef(ref: string): string {
  const { provider, model } = parseModelRef(ref);
  return modelRef(provider, model);
}

/** 发给宿主机的命令里模型和提供方分开写。 */
function splitModel(ref: string): { model: string; provider: string } {
  return parseModelRef(ref);
}

/**
 * 用哪一档思考强度：给了就要是模型支持的；没给就用 fallback（模型不支持那一档时换成最近的一档）。
 * 模型没声明推理等级时只有 off（由接口自己的默认值决定思考不思考）。
 */
export function chooseEffort(
  efforts: readonly ThinkingEffort[],
  requested: ThinkingEffort | undefined,
  fallback: ThinkingEffort,
): ThinkingEffort | undefined {
  if (efforts.length === 0)
    return requested === undefined || requested === "off" ? "off" : undefined;
  if (requested !== undefined) return efforts.includes(requested) ? requested : undefined;
  return fitEffort(efforts, fallback);
}
