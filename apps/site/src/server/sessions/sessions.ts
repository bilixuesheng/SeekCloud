import { randomInt } from "node:crypto";
import type {
  AgentEvent,
  HostCommand,
  HostEvent,
  PullRequestState,
  SafeError,
  Session,
  SessionEvent,
  SessionEventBody,
  SessionRepo,
  SessionState,
  ThinkingEffort,
} from "@seekcloud/protocol";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { AppDeps } from "../app";
import type { Tx } from "../db/client";
import {
  environments,
  queuedMessages,
  sessionEvents,
  sessionRepos,
  sessions,
  turns,
} from "../db/schema";
import { githubNotConnected } from "../errors";
import { withGitHubToken } from "../github/tokens";
import { DEFAULT_EFFORT, DEFAULT_MODEL, findModel } from "./models";
import { toSafeError } from "./safe-error";
import { Topic } from "./topic";

/** 一次读多少条事件。 */
export const EVENT_PAGE = 500;

export const sessionErrors = {
  github_not_connected: { status: 409, message: githubNotConnected.error.message },
  repo_not_found: { status: 404, message: "仓库不存在，或 SeekCloud 无权访问" },
  branch_not_found: { status: 400, message: "仓库中不存在该分支" },
  environment_not_found: { status: 404, message: "环境不存在" },
  model_not_found: { status: 400, message: "模型不存在或已下线" },
  session_not_found: { status: 404, message: "会话不存在" },
  session_closed: { status: 409, message: "会话已结束，无法继续发送消息" },
  queued_not_found: { status: 404, message: "该消息已发送或已撤回" },
} as const;

export type SessionError = keyof typeof sessionErrors;
type Result<T> = { ok: true; value: T } | { ok: false; error: SessionError };

export interface NewSession {
  /** owner/name */
  repo: string;
  baseBranch: string;
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
}

type SessionRow = typeof sessions.$inferSelect;

/** 发消息的结果：开始了下一个回合，或者 Agent 还在工作、先排队。 */
export type SendOutcome = { started: Session } | { queued: { id: string; text: string } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 去掉了容易看混的 i、l、o、u。短 ID 不走 deps.random：它要难以猜到，测试里也不能撞号。
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
  /** 某个用户的某个会话有变化。键是用户 id，值是会话短 ID。 */
  readonly #changes = new Topic<string>();

  constructor(deps: AppDeps) {
    this.#deps = deps;
    deps.host?.connect((event) => this.handleHostEvent(event));
  }

  async create(userId: string, input: NewSession): Promise<Result<Session>> {
    const { db, clock, github } = this.#deps;
    const environmentId = await this.#environmentFor(userId, input.environmentId);
    if (!environmentId) return { ok: false, error: "environment_not_found" };
    const model = findModel(input.model ?? DEFAULT_MODEL);
    const effort = input.effort ?? DEFAULT_EFFORT;
    if (!model?.efforts.includes(effort)) return { ok: false, error: "model_not_found" };

    // 装了 App 的仓库可以推送；没装的公开仓库只读挂载。
    const checked = await withGitHubToken(this.#deps, userId, async (token) => {
      const found =
        (await github.listInstalledRepos(token)).find((r) => sameName(r.fullName, input.repo)) ??
        (await github.getPublicRepo(token, input.repo));
      if (!found) return "repo_not_found" as const;
      const branches = await github.listBranches(token, found.fullName);
      if (!branches.includes(input.baseBranch)) return "branch_not_found" as const;
      return found;
    });
    if (checked === "not_connected") return { ok: false, error: "github_not_connected" };
    if (typeof checked === "string") return { ok: false, error: checked };

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
            model: model.id,
            effort,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const id = (session as SessionRow).id;
        await tx.insert(sessionRepos).values({
          sessionId: id,
          position: 0,
          fullName: checked.fullName,
          baseBranch: input.baseBranch,
          branch: sessionBranch(shortId),
          access: checked.canPush ? "push" : "read",
        });
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

  async list(userId: string): Promise<Session[]> {
    const rows = await this.#deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.updatedAt))
      .limit(200);
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
    };
  }

  /** 订阅这个用户的会话列表变化：listener 收到变了的会话的短 ID。 */
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
   */
  async sendMessage(
    userId: string,
    shortId: string,
    message: { text: string; model?: string; effort?: ThinkingEffort },
  ): Promise<Result<SendOutcome>> {
    const body = message.text.trim();
    if (message.model !== undefined || message.effort !== undefined) {
      const model = message.model === undefined ? undefined : findModel(message.model);
      if (message.model !== undefined && !model) return { ok: false, error: "model_not_found" };
      if (model && message.effort && !model.efforts.includes(message.effort)) {
        return { ok: false, error: "model_not_found" };
      }
    }
    const outcome = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return "session_not_found" as const;
      if (session.status === "waiting") {
        const command = await this.#startTurn(tx, session, { ...message, text: body });
        return { kind: "started" as const, session, command };
      }
      if (session.status === "running" || session.status === "queued") {
        const [row] = await tx
          .insert(queuedMessages)
          .values({
            sessionId: session.id,
            text: body,
            model: message.model ?? null,
            effort: message.effort ?? null,
            createdAt: this.#deps.clock.now(),
          })
          .returning({ id: queuedMessages.id });
        const queued = { id: (row as { id: string }).id, text: body };
        await this.#append(tx, session.id, null, { type: "message.queued", ...queued });
        return { kind: "queued" as const, session, queued };
      }
      return "session_closed" as const;
    });
    if (typeof outcome === "string") return { ok: false, error: outcome };
    this.#notify(outcome.session);
    if (outcome.kind === "queued") return { ok: true, value: { queued: outcome.queued } };
    this.#deps.host?.send(outcome.command);
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
   */
  async sendQueuedNow(userId: string, shortId: string, queueId: string): Promise<Result<void>> {
    if (!UUID.test(queueId)) return { ok: false, error: "queued_not_found" };
    const outcome = await this.#deps.db.transaction(async (tx) => {
      const session = await this.#lockOwn(tx, userId, shortId);
      if (!session) return "session_not_found" as const;
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
      if (session.status === "waiting") {
        return {
          session,
          command: await this.#startTurn(tx, session, { ...queued, queued: [row.id] }),
        };
      }
      const [turn] = await tx
        .select()
        .from(turns)
        .where(and(eq(turns.sessionId, session.id), eq(turns.status, "running")))
        .orderBy(desc(turns.number))
        .limit(1);
      if (!turn) return "session_closed" as const;
      await this.#append(tx, session.id, turn.number, {
        type: "user.message",
        text: row.text,
        injected: true,
        queued: [row.id],
      });
      if (session.statusDetail === "preparing_sandbox" || session.status === "queued") {
        await tx
          .update(turns)
          .set({ input: `${turn.input}\n\n${row.text}` })
          .where(eq(turns.id, turn.id));
        return { session, command: undefined };
      }
      const command: HostCommand = {
        type: "inject_message",
        sessionId: session.id,
        turnId: turn.id,
        text: row.text,
      };
      return { session, command };
    });
    if (typeof outcome === "string") return { ok: false, error: outcome };
    this.#notify(outcome.session);
    if (outcome.command) this.#deps.host?.send(outcome.command);
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

  /**
   * 用户删除账户时：所有会话立即归档（正在跑的回合算停止，排队的消息丢掉），
   * 再让宿主机删掉这些会话的沙箱。之后宿主机再发来的事件都会被忽略（回合已经不在运行）。
   */
  async closeAllForUser(userId: string): Promise<void> {
    const closed = await this.#deps.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(asc(sessions.createdAt))
        .for("update");
      const now = this.#deps.clock.now();
      for (const session of rows) {
        await tx.delete(queuedMessages).where(eq(queuedMessages.sessionId, session.id));
        if (session.status === "archived" || session.status === "failed") continue;
        const ended = await tx
          .update(turns)
          .set({ status: "stopped", endedAt: now })
          .where(and(eq(turns.sessionId, session.id), eq(turns.status, "running")))
          .returning({ number: turns.number });
        await this.#setStatus(tx, session.id, ended[0]?.number ?? null, {
          status: "archived",
          detail: null,
        });
      }
      return rows;
    });
    for (const session of closed) {
      this.#notify(session);
      this.#deps.host?.send({ type: "destroy_sandbox", sessionId: session.id });
    }
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
    input: { text: string; model?: string; effort?: ThinkingEffort; queued?: string[] },
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
    });
    await this.#setStatus(tx, session.id, number, { status: "running", detail: null });
    return {
      type: "start_turn",
      sessionId: session.id,
      turnId: (turn as { id: string }).id,
      text: input.text,
      model,
      effort,
    };
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
    if (handled.next) this.#deps.host?.send(handled.next);
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
    await this.#setStatus(tx, session.id, turn?.number ?? null, {
      status: "running",
      detail: null,
    });
    return (
      turn && {
        type: "start_turn",
        sessionId: session.id,
        turnId: turn.id,
        text: turn.input,
        model: session.model,
        effort: session.effort,
      }
    );
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
    if (turn?.status !== "running") return;
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
    // 有排队的消息就直接开始下一个回合。
    const next = await this.#startQueued(tx, session);
    if (next) return next;
    await this.#setStatus(tx, session.id, turn.number, { status: "waiting", detail: null });
    return undefined;
  }

  /** 交给宿主机准备沙箱。还没有宿主机连上来时，会话留在排队中。 */
  async #dispatch(sessionId: string): Promise<void> {
    const host = this.#deps.host;
    if (!host) return;
    const session = await this.#deps.db.transaction(async (tx) => {
      await this.#setStatus(tx, sessionId, 1, { status: "running", detail: "preparing_sandbox" });
      const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId));
      return row as SessionRow;
    });
    this.#notify(session);
    host.send({
      type: "prepare_sandbox",
      sessionId,
      repos: await this.#repos(sessionId),
      // 刚建的会话一定有环境。
      environmentId: session.environmentId as string,
      model: session.model,
      effort: session.effort,
    });
  }

  /** 追加一条会话事件。在会话这一行上加锁取号，同一个会话的序号连续、不重复。 */
  async #append(tx: Tx, sessionId: string, turn: number | null, body: SessionEventBody) {
    const now = this.#deps.clock.now();
    const [row] = await tx
      .update(sessions)
      .set({ lastSeq: sql`${sessions.lastSeq} + 1`, updatedAt: now })
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
