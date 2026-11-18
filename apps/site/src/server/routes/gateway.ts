import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppDeps } from "../app";
import { sessions, turns } from "../db/schema";
import { errorResponse, type ModelGateway } from "../gateway/gateway";
import { findModel } from "../sessions/models";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 网关自己拒绝的请求：Anthropic 格式（调用方是沙箱里的 dsh）。 */
const reject = (status: number, message: string) =>
  errorResponse({ code: "model_rejected", status, message });

/**
 * 模型网关的接口（#26），挂在 /api/gateway 下。调用方只有宿主机：沙箱只连宿主机本地的地址，
 * 宿主机核对会话临时令牌以后，带上宿主机凭据和会话的 ID 转发过来（ADR 0003）。不对外公开，不进接口文档。
 *
 * - Authorization: Bearer <宿主机凭据>：哪台宿主机；
 * - X-SeekCloud-Session: <会话 ID>：哪个会话。会话必须在这台宿主机上，而且沙箱开着（运行中、等待回复）。
 */
export function gatewayRoutes(deps: AppDeps, gateway: ModelGateway) {
  return new Hono().post("/v1/messages", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const host = token ? deps.host?.verifyCredential(token) : undefined;
    if (!host) return reject(401, "宿主机凭据无效或已过期");

    const sessionId = c.req.header("x-seekcloud-session") ?? "";
    if (!UUID.test(sessionId) || !(await deps.host?.owns(host.id, sessionId))) {
      return reject(403, "这个会话不在这台宿主机上");
    }
    const [session] = await deps.db
      .select({ userId: sessions.userId, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session || (session.status !== "running" && session.status !== "waiting")) {
      return reject(403, "会话的沙箱已经停止");
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return reject(400, "请求体不是合法的 JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reject(400, "请求体不是合法的 JSON 对象");
    }
    const model = (body as { model?: unknown }).model;
    if (typeof model !== "string" || !findModel(model)) return reject(400, "不支持这个模型");

    // 记在当前回合上；不在回合里（比如回合之间 dsh 自己整理上下文）时为空。
    const [turn] = await deps.db
      .select({ id: turns.id })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "running")))
      .orderBy(desc(turns.number))
      .limit(1);

    return gateway.messages(
      { purpose: "agent", userId: session.userId, sessionId, turnId: turn?.id ?? null, model },
      {
        headers: c.req.raw.headers,
        body: body as Record<string, unknown>,
        signal: c.req.raw.signal,
      },
    );
  });
}
