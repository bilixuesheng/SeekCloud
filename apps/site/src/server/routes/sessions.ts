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
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { DEFAULT_MODEL, MODELS } from "../sessions/models";
import { EVENT_PAGE, type SessionError, type Sessions, sessionErrors } from "../sessions/sessions";
import { serial } from "../sessions/topic";
import { readSetting } from "../settings";
import { jsonBody as json, newRouter } from "./router";

const Repo = z.object({
  fullName: z.string(),
  baseBranch: z.string(),
  branch: z.string().openapi({ description: "会话分支：seekcloud/<会话短ID>" }),
  access: z.enum(REPO_ACCESS),
});

export const Session = z
  .object({
    shortId: z.string().openapi({ description: "会话短 ID，网址和会话分支名里用它" }),
    title: z.string(),
    status: z.enum(SESSION_STATUSES),
    detail: z.enum(SESSION_STATUS_DETAILS).nullable().openapi({ description: "状态的附加说明" }),
    repos: z.array(Repo).openapi({ description: "第一个是主仓库" }),
    model: z.string(),
    effort: z.enum(THINKING_EFFORTS),
    environmentName: z.string().nullable().openapi({ description: "会话用的环境的名字" }),
    pinnedAt: z
      .string()
      .nullable()
      .openapi({ format: "date-time", description: "置顶的时间，没置顶时为 null" }),
    groupId: z
      .string()
      .nullable()
      .openapi({ description: "在侧栏的哪个分组里；置顶的、在“最近”里的为 null" }),
    sortKey: z.number().openapi({ description: "侧栏里的顺序：每一类里按它从大到小排" }),
    unread: z.boolean().openapi({ description: "有新内容（回合结束时没人开着这个会话）" }),
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
          .openapi({ description: "思考强度，不填就用设置里的默认思考强度" }),
        text: Text,
      }),
    ),
  },
  responses: {
    201: { description: "已发起", ...json(Session) },
    400: errorResponse("分支不存在或请求格式不对"),
    401: errorResponse("没有登录"),
    404: errorResponse("仓库或环境不存在"),
    409: errorResponse("还没有关联 GitHub，或者还没有填模型服务的 API key"),
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
    "连上后先发一条 snapshot（全部会话和侧栏的分组），之后每当某个会话有变化，发一条 session（这个会话的最新内容）；" +
    "会话被删了发 removed；分组建了、改名了、删了，发一条 groups（全部分组）。",
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
        mode: z.enum(["now", "later"]).optional().openapi({
          description:
            "Agent 在工作时：now 直接插进当前回合，later（默认）排队到回合结束。换了模型或思考强度时总是排队",
        }),
      }),
    ),
  },
  responses: {
    201: { description: "已开始下一个回合", ...json(Session) },
    202: {
      description:
        "Agent 还在工作：消息已排队（queued），回合结束后作为下一回合的开头；或者已插进当前回合（injected）",
      ...json(
        z.union([
          z.object({ queued: z.object({ id: z.string(), text: z.string() }) }),
          z.object({ injected: z.literal(true) }),
        ]),
      ),
    },
    400: errorResponse("没有这个模型"),
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
    409: errorResponse("会话已经结束"),
  },
});

const stopRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/stop",
  summary: "停止正在跑的回合（后台命令不停；还有排队的消息就用它们开始下一个回合）",
  request: { params: ShortIdParam },
  responses: {
    200: { description: "已停止", ...json(z.object({ stopped: z.literal(true) })) },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
    409: errorResponse("当前没有正在运行的回合"),
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

const MessagePinSchema = z
  .object({
    seq: z.number().int().openapi({ description: "那条 Agent 回复的事件序号" }),
    title: z.string().nullable().openapi({ description: "短标题，为 null 表示还在生成" }),
    createdAt: z.string().openapi({ format: "date-time" }),
  })
  .openapi("MessagePin");

const RepoDiffSchema = z
  .object({
    fullName: z.string(),
    baseBranch: z.string(),
    base: z.string().openapi({ description: "会话分支和基础分支分开的那个提交" }),
    head: z.string().openapi({ description: "会话分支现在的提交" }),
    files: z.array(
      z.object({
        path: z.string(),
        from: z.string().optional().openapi({ description: "改名的原路径" }),
        additions: z.number().int(),
        deletions: z.number().int(),
        binary: z.boolean().optional(),
        patch: z.string().optional().openapi({ description: "git diff 的原文；太大的不带" }),
        tooLarge: z.boolean().optional(),
      }),
    ),
    truncated: z.boolean().optional().openapi({ description: "文件太多、patch 太大，后面的没带" }),
  })
  .openapi("RepoDiff");

const diffRoute = createRoute({
  method: "get",
  path: "/sessions/{shortId}/diff",
  summary: "会话分支对比基础分支的改动（改动面板）",
  description:
    "每个回合结束时宿主机算一份，这里是每个仓库最新的那份。还没有回合结束过的仓库不在里面。",
  request: { params: ShortIdParam },
  responses: {
    200: { description: "按会话的仓库顺序", ...json(z.object({ repos: z.array(RepoDiffSchema) })) },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
  },
});

const listPinsRoute = createRoute({
  method: "get",
  path: "/sessions/{shortId}/pins",
  summary: "会话里置顶的消息",
  request: { params: ShortIdParam },
  responses: {
    200: {
      description: "按在会话里的先后排",
      ...json(z.object({ pins: z.array(MessagePinSchema) })),
    },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
  },
});

const setPinRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/pins",
  summary: "置顶或取消置顶一条 Agent 回复",
  request: {
    params: ShortIdParam,
    body: json(z.object({ seq: z.number().int().positive(), pinned: z.boolean() })),
  },
  responses: {
    200: {
      description: "置顶后的整个列表",
      ...json(z.object({ pins: z.array(MessagePinSchema) })),
    },
    401: errorResponse("没有登录"),
    404: errorResponse("会话或消息不存在"),
  },
});

const readRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/read",
  summary: "标为已读或未读：打开会话时标已读，菜单里能手动标未读",
  request: { params: ShortIdParam, body: json(z.object({ unread: z.boolean() })) },
  responses: {
    200: { description: "已标好", ...json(Session) },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
  },
});

const pinRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/pin",
  summary: "置顶或取消置顶：侧栏里置顶的会话放在最上面一组",
  request: { params: ShortIdParam, body: json(z.object({ pinned: z.boolean() })) },
  responses: {
    200: { description: "已置顶或已取消置顶（重复操作不变）", ...json(Session) },
    401: errorResponse("没有登录"),
    404: errorResponse("会话不存在"),
    409: errorResponse("已归档的会话不能置顶"),
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

/**
 * 打开一条 SSE。start 开始推送，返回停止推送的函数；浏览器断开时调用它。
 * 每次保活前再问一次身份来源：这期间这台设备被退出了（设备列表、在所有设备上退出、改密码、在服务器上
 * 重置密码）就断开，不再推送。
 */
function eventStream(
  deps: AppDeps,
  c: Context,
  start: (stream: SSEStreamingApi) => Promise<() => void>,
): Response {
  // 让反向代理不要缓冲。
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
    const stop = await start(stream);
    const keepalive = setInterval(
      () =>
        void (async () => {
          const still = await deps.identity.currentUser(c).catch(() => undefined);
          if (!still) stream.abort();
          else await stream.write(": keepalive\n\n");
        })(),
      deps.streamKeepaliveMs ?? KEEPALIVE_MS,
    );
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
      const user = await deps.identity.currentUser(c);
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
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      return c.json(
        {
          models: MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })),
          defaultModel: DEFAULT_MODEL,
          defaultEffort: await readSetting(deps, "default_effort", { userId: user.id }),
        },
        200,
      );
    })
    .openapi(listSessionsRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      return c.json({ sessions: await sessions.list(user.id) }, 200);
    })
    .openapi(sessionListStreamRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      return eventStream(deps, c, async (stream) => {
        let snapshotSent = false;
        let groupsChanged = false;
        const changed = new Set<string>();
        const push = guarded(stream, async () => {
          if (!snapshotSent) {
            changed.clear();
            groupsChanged = false;
            const all = await sessions.list(user.id);
            const groups = await sessions.sidebar.groups(user.id);
            await stream.writeSSE({
              event: "snapshot",
              data: JSON.stringify({ sessions: all, groups }),
            });
            snapshotSent = true;
          }
          if (groupsChanged) {
            groupsChanged = false;
            const groups = await sessions.sidebar.groups(user.id);
            await stream.writeSSE({ event: "groups", data: JSON.stringify({ groups }) });
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
        const unsubscribeGroups = sessions.subscribeGroups(user.id, () => {
          groupsChanged = true;
          void push();
        });
        void push();
        return () => {
          unsubscribe();
          unsubscribeGroups();
        };
      });
    })
    .openapi(getSessionRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const session = await sessions.get(user.id, c.req.valid("param").shortId);
      if (!session) return c.json(fail("session_not_found").body, 404);
      return c.json(session, 200);
    })
    .openapi(sessionEventsRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const handle = await sessions.open(user.id, c.req.valid("param").shortId);
      if (!handle) return c.json(fail("session_not_found").body, 404);
      let last = c.req.valid("header")["last-event-id"] ?? c.req.valid("query").after ?? 0;
      return eventStream(deps, c, async (stream) => {
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
        // 模型进度和文字增量只推送、不落库，没有序号，断线重连也不补
        const stopLive = handle.subscribeLive((live) => {
          stream
            .writeSSE({ event: live.event, data: JSON.stringify(live.data) })
            .catch(() => undefined);
        });
        void push();
        return () => {
          unsubscribe();
          stopLive();
        };
      });
    })
    .openapi(sendMessageRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
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
      if ("injected" in result.value) return c.json({ injected: true as const }, 202);
      return c.json(result.value.started, 201);
    })
    .openapi(stopRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.stopTurn(user.id, c.req.valid("param").shortId);
      if (!result.ok) {
        const { body, status } = fail(result.error);
        return c.json(body, status as 404 | 409);
      }
      return c.json({ stopped: true as const }, 200);
    })
    .openapi(withdrawRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
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
      const user = await deps.identity.currentUser(c);
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
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.rename(
        user.id,
        c.req.valid("param").shortId,
        c.req.valid("json").title,
      );
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json(result.value, 200);
    })
    .openapi(diffRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.listDiffs(user.id, c.req.valid("param").shortId);
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json({ repos: result.value }, 200);
    })
    .openapi(listPinsRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.listPins(user.id, c.req.valid("param").shortId);
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json({ pins: result.value }, 200);
    })
    .openapi(setPinRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const { seq, pinned } = c.req.valid("json");
      const result = await sessions.setMessagePin(
        user.id,
        c.req.valid("param").shortId,
        seq,
        pinned,
      );
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json({ pins: result.value }, 200);
    })
    .openapi(readRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.setUnread(
        user.id,
        c.req.valid("param").shortId,
        c.req.valid("json").unread,
      );
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json(result.value, 200);
    })
    .openapi(pinRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.setPinned(
        user.id,
        c.req.valid("param").shortId,
        c.req.valid("json").pinned,
      );
      if (!result.ok) {
        const { body, status } = fail(result.error);
        return c.json(body, status as 404 | 409);
      }
      return c.json(result.value, 200);
    })
    .openapi(archiveRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.archive(user.id, c.req.valid("param").shortId);
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json(result.value, 200);
    })
    .openapi(unarchiveRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.unarchive(user.id, c.req.valid("param").shortId);
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.json(result.value, 200);
    })
    .openapi(deleteRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.remove(user.id, c.req.valid("param").shortId);
      if (!result.ok) return c.json(fail(result.error).body, 404);
      return c.body(null, 204);
    });
}
