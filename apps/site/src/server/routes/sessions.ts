import { createRoute, z } from "@hono/zod-openapi";
import {
  REPO_ACCESS,
  SESSION_STATUS_DETAILS,
  SESSION_STATUSES,
  THINKING_EFFORTS,
} from "@seekcloud/protocol";
import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { recordAccess } from "../access-log";
import type { AppDeps } from "../app";
import { currentUser } from "../auth/login-sessions";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { DEFAULT_EFFORT, DEFAULT_MODEL, MODELS } from "../sessions/models";
import { EVENT_PAGE, type SessionError, type Sessions, sessionErrors } from "../sessions/sessions";
import { serial } from "../sessions/topic";
import { jsonBody as json, newRouter } from "./router";

const Repo = z.object({
  fullName: z.string(),
  baseBranch: z.string(),
  branch: z.string().openapi({ description: "会话分支：seekcloud/<会话短ID>" }),
  access: z.enum(REPO_ACCESS),
});

const Session = z
  .object({
    shortId: z.string().openapi({ description: "会话短 ID，网址和会话分支名里用它" }),
    title: z.string(),
    status: z.enum(SESSION_STATUSES),
    detail: z.enum(SESSION_STATUS_DETAILS).nullable().openapi({ description: "状态的附加说明" }),
    repos: z.array(Repo).openapi({ description: "第一个是主仓库" }),
    model: z.string(),
    effort: z.enum(THINKING_EFFORTS),
    createdAt: z.string().openapi({ format: "date-time" }),
    updatedAt: z.string().openapi({ format: "date-time" }),
  })
  .openapi("Session");

const Text = z.string().trim().min(1, "消息不能为空").max(100_000, "消息过长");
const ShortIdParam = z.object({ shortId: z.string() });
const eventStreamBody = (description: string) => ({
  description,
  content: { "text/event-stream": { schema: z.string() } },
});

const createSessionRoute = createRoute({
  method: "post",
  path: "/sessions",
  summary: "发起会话",
  request: {
    body: json(
      z.object({
        repo: z.string().openapi({ example: "octocat/hello-world" }),
        baseBranch: z.string(),
        environmentId: z.string().optional().openapi({ description: "不填就用默认环境" }),
        model: z
          .string()
          .optional()
          .openapi({ description: "不填就用默认模型", example: "deepseek-flash" }),
        effort: z
          .enum(THINKING_EFFORTS)
          .optional()
          .openapi({ description: "思考强度，不填就是 high" }),
        text: Text,
      }),
    ),
  },
  responses: {
    201: { description: "已发起", ...json(Session) },
    400: errorResponse("分支不存在或请求格式不对"),
    401: errorResponse("没有登录"),
    404: errorResponse("仓库或环境不存在"),
    409: errorResponse("还没有关联 GitHub"),
  },
});

const listModelsRoute = createRoute({
  method: "get",
  path: "/models",
  summary: "可选的模型和思考强度",
  responses: {
    200: {
      description: "模型列表",
      ...json(
        z.object({
          models: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              description: z.string(),
              vision: z.boolean(),
              efforts: z.array(z.enum(THINKING_EFFORTS)),
            }),
          ),
          defaultModel: z.string(),
          defaultEffort: z.enum(THINKING_EFFORTS),
        }),
      ),
    },
    401: errorResponse("没有登录"),
  },
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  summary: "我的会话，最近有动静的在前",
  responses: {
    200: { description: "会话列表", ...json(z.object({ sessions: z.array(Session) })) },
    401: errorResponse("没有登录"),
  },
});

const sessionListStreamRoute = createRoute({
  method: "get",
  path: "/sessions/stream",
  summary: "会话列表的变化（SSE）",
  description:
    "连上后先发一条 snapshot（全部会话），之后每当某个会话有变化，发一条 session（这个会话的最新内容）。",
  responses: {
    200: eventStreamBody("事件流"),
    401: errorResponse("没有登录"),
  },
});

const getSessionRoute = createRoute({
  method: "get",
  path: "/sessions/{shortId}",
  summary: "一个会话",
  request: { params: ShortIdParam },
  responses: {
    200: { description: "会话", ...json(Session) },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
  },
});

const sessionEventsRoute = createRoute({
  method: "get",
  path: "/sessions/{shortId}/events",
  summary: "会话事件流（SSE）",
  description:
    "先补发序号大于 Last-Event-ID（或 after）的事件，然后实时推送新事件。每条事件的 id 是会话内的序号。",
  request: {
    params: ShortIdParam,
    query: z.object({ after: z.coerce.number().int().min(0).optional() }),
    headers: z.object({ "last-event-id": z.coerce.number().int().min(0).optional() }),
  },
  responses: {
    200: eventStreamBody("事件流"),
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
  },
});

const sendMessageRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/messages",
  summary: "发消息：会话在等待回复就开始下一个回合；Agent 还在工作就先排队",
  request: {
    params: ShortIdParam,
    body: json(
      z.object({
        text: Text,
        model: z.string().optional().openapi({ description: "换模型，从这个回合起生效" }),
        effort: z.enum(THINKING_EFFORTS).optional().openapi({ description: "换思考强度" }),
      }),
    ),
  },
  responses: {
    201: { description: "已开始下一个回合", ...json(Session) },
    202: {
      description: "Agent 还在工作，消息已排队，回合结束后作为下一回合的开头",
      ...json(z.object({ queued: z.object({ id: z.string(), text: z.string() }) })),
    },
    400: errorResponse("没有这个模型"),
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
    409: errorResponse("会话已经结束"),
  },
});

const QueueParam = z.object({
  shortId: z.string(),
  queueId: z.string().openapi({ description: "排队消息的 ID" }),
});

const withdrawRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/queue/{queueId}/withdraw",
  summary: "撤回一条排队的消息，返回原文",
  request: { params: QueueParam },
  responses: {
    200: { description: "已撤回", ...json(z.object({ text: z.string() })) },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在，或者这条消息已经发出去、撤回了"),
  },
});

const sendNowRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/queue/{queueId}/send-now",
  summary: "排队的消息立即发送：Agent 在当前回合的下一步读到它",
  request: { params: QueueParam },
  responses: {
    200: { description: "已发送", ...json(z.object({ sent: z.literal(true) })) },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在，或者这条消息已经发出去、撤回了"),
    409: errorResponse("会话已经结束"),
  },
});

const Title = z.string().trim().min(1, "标题不能为空").max(100, "标题最长 100 个字");

const renameRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/rename",
  summary: "给会话改名",
  request: { params: ShortIdParam, body: json(z.object({ title: Title })) },
  responses: {
    200: { description: "已改名", ...json(Session) },
    400: errorResponse("标题为空或太长"),
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
  },
});

const archiveRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/archive",
  summary: "归档：正在跑的回合停下，沙箱删掉，会话不再接收消息",
  request: { params: ShortIdParam },
  responses: {
    200: { description: "已归档（已经归档的再归档一次不变）", ...json(Session) },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
  },
});

const unarchiveRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/unarchive",
  summary: "取消归档：会话回到休眠，发消息就唤醒",
  request: { params: ShortIdParam },
  responses: {
    200: { description: "已取消归档（没归档的会话不变）", ...json(Session) },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
  },
});

const deleteRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/delete",
  summary: "删除会话：对话记录一起删掉，GitHub 上的分支和 PR 不动",
  request: { params: ShortIdParam },
  responses: {
    204: { description: "已删除" },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
  },
});

const fail = (error: SessionError) => ({
  body: apiError(error, sessionErrors[error].message),
  status: sessionErrors[error].status,
});

/** 代理和浏览器之间长时间没数据会断开，每隔一会儿发一行注释。 */
const KEEPALIVE_MS = 25_000;

/** 打开一条 SSE。start 开始推送，返回停止推送的函数；浏览器断开时调用它。 */
function eventStream(
  c: Context,
  start: (stream: SSEStreamingApi) => Promise<() => void>,
): Response {
  // 让反向代理不要缓冲。
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
    const stop = await start(stream);
    const keepalive = setInterval(() => void stream.write(": keepalive\n\n"), KEEPALIVE_MS);
    if (!stream.aborted) await closed;
    clearInterval(keepalive);
    stop();
  });
}

/** 推送出错（比如数据库暂时连不上）时断开，浏览器会带着 Last-Event-ID 自动重连。 */
function guarded(stream: SSEStreamingApi, push: () => Promise<void>) {
  return serial(async () => {
    try {
      await push();
    } catch (error) {
      console.error(error);
      stream.abort();
    }
  });
}

/** 会话：发起、列表、事件流、发消息。 */
export function sessionRoutes(deps: AppDeps, sessions: Sessions) {
  return newRouter()
    .openapi(createSessionRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.create(user.id, c.req.valid("json"));
      if (!result.ok) {
        const { body, status } = fail(result.error);
        return c.json(body, status as 400 | 404 | 409);
      }
      await recordAccess(deps, c, user.id, "session_start");
      return c.json(result.value, 201);
    })
    .openapi(listModelsRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      return c.json(
        {
          models: MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })),
          defaultModel: DEFAULT_MODEL,
          defaultEffort: DEFAULT_EFFORT,
        },
        200,
      );
    })
    .openapi(listSessionsRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      return c.json({ sessions: await sessions.list(user.id) }, 200);
    })
    .openapi(sessionListStreamRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      return eventStream(c, async (stream) => {
        let snapshotSent = false;
        const changed = new Set<string>();
        const push = guarded(stream, async () => {
          if (!snapshotSent) {
            changed.clear();
            const all = await sessions.list(user.id);
            await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ sessions: all }) });
            snapshotSent = true;
          }
          for (const shortId of [...changed]) {
            changed.delete(shortId);
            const session = await sessions.get(user.id, shortId);
            if (session) await stream.writeSSE({ event: "session", data: JSON.stringify(session) });
            // 找不到就是删掉了：告诉浏览器从列表里拿掉。
            else await stream.writeSSE({ event: "removed", data: JSON.stringify({ shortId }) });
          }
        });
        const unsubscribe = sessions.subscribeChanges(user.id, (shortId) => {
          changed.add(shortId);
          void push();
        });
        void push();
        return unsubscribe;
      });
    })
    .openapi(getSessionRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const session = await sessions.get(user.id, c.req.valid("param").shortId);
      if (!session) return c.json(fail("session_not_found").body, 404);
      return c.json(session, 200);
    })
    .openapi(sessionEventsRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const handle = await sessions.open(user.id, c.req.valid("param").shortId);
      if (!handle) return c.json(fail("session_not_found").body, 404);
      let last = c.req.valid("header")["last-event-id"] ?? c.req.valid("query").after ?? 0;
      return eventStream(c, async (stream) => {
        // 先订阅再读库，读库期间来的新事件不会漏；按序号续读，也不会重复。
        const push = guarded(stream, async () => {
          for (;;) {
            const batch = await handle.eventsAfter(last);
            for (const event of batch) {
              await stream.writeSSE({
                event: "session",
                id: String(event.seq),
                data: JSON.stringify(event),
              });
              last = event.seq;
            }
            if (batch.length < EVENT_PAGE) break;
          }
        });
        const unsubscribe = handle.subscribe(() => void push());
        void push();
        return unsubscribe;
      });
    })
    .openapi(sendMessageRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.sendMessage(
        user.id,
        c.req.valid("param").shortId,
        c.req.valid("json"),
      );
      if (!result.ok) {
        const { body, status } = fail(result.error);
        return c.json(body, status as 400 | 404 | 409);
      }
      await recordAccess(deps, c, user.id, "message");
      if ("queued" in result.value) return c.json({ queued: result.value.queued }, 202);
      return c.json(result.value.started, 201);
    })
    .openapi(withdrawRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const { shortId, queueId } = c.req.valid("param");
      const result = await sessions.withdrawQueued(user.id, shortId, queueId);
      if (!result.ok) {
        const { body } = fail(result.error);
        return c.json(body, 404);
      }
      return c.json({ text: result.value }, 200);
    })
    .openapi(sendNowRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const { shortId, queueId } = c.req.valid("param");
      const result = await sessions.sendQueuedNow(user.id, shortId, queueId);
      if (!result.ok) {
        const { body, status } = fail(result.error);
        return c.json(body, status as 404 | 409);
      }
      return c.json({ sent: true as const }, 200);
    })
    .openapi(renameRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.rename(
        user.id,
        c.req.valid("param").shortId,
        c.req.valid("json").title,
      );
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json(result.value, 200);
    })
    .openapi(archiveRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.archive(user.id, c.req.valid("param").shortId);
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json(result.value, 200);
    })
    .openapi(unarchiveRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.unarchive(user.id, c.req.valid("param").shortId);
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json(result.value, 200);
    })
    .openapi(deleteRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.remove(user.id, c.req.valid("param").shortId);
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.body(null, 204);
    });
}
