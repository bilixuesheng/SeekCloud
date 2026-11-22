import { DEEPSEEK_PROVIDER, modelRef } from "@seekcloud/protocol";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppDeps } from "../app";
import { sessions, turns } from "../db/schema";
import { errorResponse } from "../gateway/failures";
import { webFetch } from "../gateway/fetch";
import { GatewayFiles } from "../gateway/files";
import type { ModelGateway } from "../gateway/gateway";
import {
  modelOfRequest,
  protocolOfPath,
  safeProviderPath,
  upstreamSearch,
} from "../gateway/provider-path";
import { webSearch } from "../gateway/web";
import { type ModelCatalog, PROVIDER_ID } from "../models/providers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 网关自己拒绝的请求：Anthropic 格式（调用方是沙箱里的 dsh）。 */
const reject = (status: number, message: string) =>
  errorResponse({ code: "model_rejected", status, message });

/** 认证通过的请求是哪个会话的。 */
interface GatewaySession {
  id: string;
  userId: string;
  /** 正在跑的回合；不在回合里（比如回合之间 dsh 自己整理上下文）时为空。 */
  turnId: string | null;
}

type GatewayEnv = { Variables: { session: GatewaySession } };

/** 读 JSON 对象的请求体；不是合法的 JSON 对象时返回拒绝的响应。 */
async function jsonObject(req: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reject(400, "请求体不是合法的 JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return reject(400, "请求体不是合法的 JSON 对象");
  }
  return body as Record<string, unknown>;
}

/**
 * 模型网关的接口（#26），挂在 /api/gateway 下。调用方只有宿主机：沙箱只连宿主机本地的地址，
 * 宿主机核对会话临时令牌以后，带上宿主机凭据和会话的 ID 转发过来（ADR 0003）。不对外公开，不进接口文档。
 *
 * - Authorization: Bearer <宿主机凭据>：哪台宿主机；
 * - X-SeekCloud-Session: <会话 ID>：哪个会话。会话必须在这台宿主机上，而且沙箱开着（运行中、等待回复）。
 *
 * 接口和 Anthropic、DeepSeek 的一样（dsh 照原样调）：/v1/messages、/v1/files…、/v1/tools/search、/v1/tools/fetch。
 * 别的提供方走透明转发 /providers/{id}/…（#113）。
 */
export function gatewayRoutes(deps: AppDeps, gateway: ModelGateway, models: ModelCatalog) {
  const files = new GatewayFiles(deps);

  const authenticate = createMiddleware<GatewayEnv>(async (c, next) => {
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
    const [turn] = await deps.db
      .select({ id: turns.id })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "running")))
      .orderBy(desc(turns.number))
      .limit(1);
    c.set("session", { id: sessionId, userId: session.userId, turnId: turn?.id ?? null });
    await next();
  });

  const owner = (s: GatewaySession) => ({ userId: s.userId, sessionId: s.id });

  return (
    new Hono<GatewayEnv>()
      .use("*", authenticate)
      .post("/v1/messages", async (c) => {
        const session = c.get("session");
        const body = await jsonObject(c.req.raw);
        if (body instanceof Response) return body;
        // 这个接口是 DeepSeek 官方的（Anthropic 格式）：模型是 DeepSeek 能用的那些（#113）
        const model = typeof body.model === "string" ? modelRef(DEEPSEEK_PROVIDER, body.model) : "";
        if (!model || !(await models.find(model))) return reject(400, "不支持这个模型");
        const providers = await files.referencedProviders(owner(session), body);
        if (providers === undefined) {
          return reject(400, "请求里引用的文件不存在，或者不是这个会话上传的");
        }
        return gateway.messages(
          {
            purpose: "agent",
            userId: session.userId,
            sessionId: session.id,
            turnId: session.turnId,
            model,
          },
          {
            headers: c.req.raw.headers,
            body,
            signal: c.req.raw.signal,
            providers: providers ?? undefined,
          },
        );
      })
      .post("/v1/tools/search", async (c) => {
        const session = c.get("session");
        const body = await jsonObject(c.req.raw);
        if (body instanceof Response) return body;
        return webSearch(
          deps,
          { tool: "web_search", ...owner(session), turnId: session.turnId },
          { headers: c.req.raw.headers, body, signal: c.req.raw.signal },
        );
      })
      .post("/v1/tools/fetch", async (c) => {
        const session = c.get("session");
        const body = await jsonObject(c.req.raw);
        if (body instanceof Response) return body;
        return webFetch(
          deps,
          { tool: "web_fetch", ...owner(session), turnId: session.turnId },
          { body, signal: c.req.raw.signal },
        );
      })
      .post("/v1/files", (c) =>
        files.upload(owner(c.get("session")), {
          headers: c.req.raw.headers,
          body: c.req.raw.body,
          signal: c.req.raw.signal,
        }),
      )
      .get("/v1/files", (c) => files.list(owner(c.get("session")), new URL(c.req.url).searchParams))
      .get("/v1/files/:id", (c) => files.retrieve(owner(c.get("session")), c.req.param("id")))
      .delete("/v1/files/:id", (c) =>
        files.delete(owner(c.get("session")), c.req.param("id"), {
          headers: c.req.raw.headers,
          signal: c.req.raw.signal,
        }),
      )
      // 每个提供方一个透明转发（#113）：沙箱里的 dsh 把这个提供方的地址配成 /v1/providers/<id>（宿主机转到这里），
      // 用各家自己的协议说话；网关换上真正的 key，原样转给 基础 URL + 剩下的路径。
      .post("/providers/:id/*", async (c) => {
        const session = c.get("session");
        const provider = c.req.param("id");
        if (!PROVIDER_ID.test(provider)) return reject(404, "没有这个模型服务");
        const url = new URL(c.req.url);
        const prefix = `/api/gateway/providers/${provider}`;
        const path = url.pathname.startsWith(prefix)
          ? safeProviderPath(url.pathname.slice(prefix.length))
          : undefined;
        if (!path) return reject(400, "路径不合法");
        const protocol = protocolOfPath(path);
        if (!protocol)
          return reject(404, "模型网关只转发模型调用（对话、Responses、Messages、Gemini 生成）");
        const body = await jsonObject(c.req.raw);
        if (body instanceof Response) return body;
        const model = modelOfRequest(protocol, path, body);
        if (!model) return reject(400, "请求里没有模型");
        return gateway.passThrough(
          {
            purpose: "agent",
            userId: session.userId,
            sessionId: session.id,
            turnId: session.turnId,
            model: modelRef(provider, model),
          },
          {
            provider,
            protocol,
            path,
            search: upstreamSearch(url.search),
            headers: c.req.raw.headers,
            body,
            signal: c.req.raw.signal,
          },
        );
      })
      .all("*", () => reject(404, "模型网关没有这个接口"))
  );
}
