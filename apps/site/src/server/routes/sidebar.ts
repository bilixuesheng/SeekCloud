import { createRoute, z } from "@hono/zod-openapi";
import { MAX_GROUP_NAME } from "@seekcloud/protocol";
import type { AppDeps } from "../app";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import type { Sessions } from "../sessions/sessions";
import { groupName, MAX_GROUPS, type SidebarError } from "../sessions/sidebar";
import { jsonBody as json, newRouter } from "./router";
import { Session } from "./sessions";

/** 侧栏的分组和顺序（#153）：建、改名、删分组，把会话放到置顶、某个分组、"最近"里的某个位置。 */

const SessionGroup = z
  .object({ id: z.string(), name: z.string(), sortKey: z.number() })
  .openapi("SessionGroup", { description: "侧栏里的一个分组，分组之间按 sortKey 从小到大排" });

const GroupName = z
  .object({ name: z.string().max(1000) })
  .openapi({ description: `分组名，去掉首尾空格以后不能为空，最长 ${MAX_GROUP_NAME} 个字` });
const GroupIdParam = z.object({ id: z.uuid() });

const errors: Record<SidebarError | "invalid_group_name", { status: number; message: string }> = {
  session_not_found: { status: 404, message: "会话不存在" },
  session_archived: { status: 409, message: "已归档的会话不能放进置顶或分组，请先取消归档" },
  group_not_found: { status: 404, message: "分组不存在" },
  too_many_groups: { status: 409, message: `分组最多 ${MAX_GROUPS} 个` },
  invalid_group_name: { status: 400, message: `分组名不能为空，最长 ${MAX_GROUP_NAME} 个字` },
};
const fail = (error: keyof typeof errors) => apiError(error, errors[error].message);

const listGroupsRoute = createRoute({
  method: "get",
  path: "/session-groups",
  summary: "侧栏的分组",
  responses: {
    200: { description: "全部分组，按顺序", ...json(z.object({ groups: z.array(SessionGroup) })) },
    401: errorResponse("没有登录"),
  },
});

const createGroupRoute = createRoute({
  method: "post",
  path: "/session-groups",
  summary: "新建分组",
  description: "放在所有分组的最后。",
  request: { body: json(GroupName) },
  responses: {
    201: { description: "建好的分组", ...json(SessionGroup) },
    400: errorResponse("分组名为空或过长"),
    401: errorResponse("没有登录"),
    409: errorResponse("分组太多"),
  },
});

const renameGroupRoute = createRoute({
  method: "patch",
  path: "/session-groups/{id}",
  summary: "改分组名",
  request: { params: GroupIdParam, body: json(GroupName) },
  responses: {
    200: { description: "改好的分组", ...json(SessionGroup) },
    400: errorResponse("分组名为空或过长"),
    401: errorResponse("没有登录"),
    404: errorResponse("分组不存在"),
  },
});

const deleteGroupRoute = createRoute({
  method: "delete",
  path: "/session-groups/{id}",
  summary: "删除分组",
  description: "里面的会话回到“最近”，按各自最近有动静的时间排；正在运行的照常运行。",
  request: { params: GroupIdParam },
  responses: {
    204: { description: "已删除" },
    401: errorResponse("没有登录"),
    404: errorResponse("分组不存在"),
  },
});

const placeRoute = createRoute({
  method: "post",
  path: "/sessions/{shortId}/place",
  summary: "把会话放到侧栏的某一类里的某个位置",
  description:
    "section 是置顶（pinned）、某个分组（group，带 groupId）或“最近”（recent）；after 是放下以后挨在它上面的" +
    "那个会话的短 ID，null 是最上面。after 不在那一类里了（这期间列表变了）时放在最上面。" +
    "放进置顶就离开分组，放进分组就取消置顶。",
  request: {
    params: z.object({ shortId: z.string() }),
    body: json(
      z.object({
        section: z.enum(["pinned", "group", "recent"]),
        groupId: z.uuid().optional(),
        after: z.string().nullable(),
      }),
    ),
  },
  responses: {
    200: { description: "放好以后的会话", ...json(Session) },
    400: errorResponse("放进分组时没给 groupId"),
    401: errorResponse("没有登录"),
    404: errorResponse("会话或分组不存在"),
    409: errorResponse("已归档的会话不能放"),
  },
});

export function sidebarRoutes(deps: AppDeps, sessions: Sessions) {
  return newRouter()
    .openapi(listGroupsRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      return c.json({ groups: await sessions.sidebar.groups(user.id) }, 200);
    })
    .openapi(createGroupRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const name = groupName(c.req.valid("json").name);
      if (!name) return c.json(fail("invalid_group_name"), 400);
      const result = await sessions.sidebar.createGroup(user.id, name);
      if (!result.ok) return c.json(fail(result.error), 409);
      return c.json(result.value, 201);
    })
    .openapi(renameGroupRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const name = groupName(c.req.valid("json").name);
      if (!name) return c.json(fail("invalid_group_name"), 400);
      const result = await sessions.sidebar.renameGroup(user.id, c.req.valid("param").id, name);
      if (!result.ok) return c.json(fail(result.error), 404);
      return c.json(result.value, 200);
    })
    .openapi(deleteGroupRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const result = await sessions.sidebar.deleteGroup(user.id, c.req.valid("param").id);
      if (!result.ok) return c.json(fail(result.error), 404);
      return c.body(null, 204);
    })
    .openapi(placeRoute, async (c) => {
      const user = await deps.identity.currentUser(c);
      if (!user) return c.json(notLoggedIn, 401);
      const { shortId } = c.req.valid("param");
      const { section, groupId, after } = c.req.valid("json");
      if (section === "group" && !groupId) {
        return c.json(apiError("group_required", "放进分组时要给出分组"), 400);
      }
      const result = await sessions.sidebar.place(
        user.id,
        shortId,
        section === "group" ? { kind: "group", groupId: groupId as string } : { kind: section },
        after,
      );
      if (!result.ok) {
        const status = errors[result.error].status as 404 | 409;
        return c.json(fail(result.error), status);
      }
      const session = await sessions.get(user.id, shortId);
      if (!session) return c.json(fail("session_not_found"), 404);
      return c.json(session, 200);
    });
}
