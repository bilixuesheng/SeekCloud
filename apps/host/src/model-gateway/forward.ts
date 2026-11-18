import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { GitSessions } from "../git-proxy/sessions";

/** 主站上模型网关的入口（apps/site 的 routes/gateway.ts）。 */
const SITE_GATEWAY_PATH = "/api/gateway";

/** 转给主站的请求头只留这几个：内容的格式、长度，和 Anthropic 的版本、测试功能开关。 */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "content-length",
  "accept",
  "anthropic-version",
  "anthropic-beta",
];
/** 主站回的响应头只留这几个（主站本来也只给这几个，这里再挡一道）。 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after"];

export interface ModelGatewayLink {
  /** 主站对外的地址（SEEKCLOUD_SITE_URL）。 */
  siteUrl: string;
  /** 现在的宿主机凭据；没连上主站、凭据过期时为空。 */
  credential(): string | undefined;
}

/** Anthropic 格式的错误：沙箱里的 dsh 按这个格式读。 */
function reply(res: ServerResponse, status: number, type: string, message: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

/** 会话临时令牌：dsh 调 Messages、Files 时放在 x-api-key 里，调联网工具时放在 Authorization: Bearer 里。 */
function sessionToken(req: IncomingMessage): string | undefined {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  const auth = req.headers.authorization ?? "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
}

/**
 * 模型网关在宿主机这一半（#26，ADR 0003）：沙箱里的 dsh 把模型、Files、联网搜索和抓取的请求发到宿主机本地的
 * /v1/…（和 Git 代理同一个端口，dsh 的接口地址设成这个端口），宿主机核对会话临时令牌，换上自己的宿主机凭据和
 * 会话 ID，转给主站的 /api/gateway/v1/…。请求体和响应都边收边转，流式回复不攒整段。
 *
 * 会话临时令牌只在宿主机这里认，不往主站带；主站只认宿主机凭据，并核对会话是不是在这台宿主机上。
 */
export async function forwardToGateway(
  link: ModelGatewayLink,
  sessions: GitSessions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = req.url ?? "/";
  // 只转 /v1/ 下面的。路径里的 ".."、编码过的点和斜杠、反斜杠一律不收：拼到主站的地址上时不能跑出 /api/gateway。
  const rawPath = raw.split("?")[0] ?? "";
  if (/\.\.|%2e|%2f|%5c|\\/i.test(rawPath)) {
    req.resume();
    return reply(res, 400, "invalid_request_error", "看不懂的地址");
  }
  const url = new URL(raw, "http://localhost");
  if (!url.pathname.startsWith("/v1/")) {
    req.resume();
    return reply(res, 404, "not_found_error", "没有这个地址");
  }
  const token = sessionToken(req);
  const session = token ? sessions.byToken(token) : undefined;
  if (!session) {
    req.resume();
    return reply(res, 401, "authentication_error", "会话令牌不对，或者会话已经结束");
  }
  const credential = link.credential();
  if (!credential) {
    req.resume();
    return reply(res, 503, "overloaded_error", "宿主机暂时连不上主站，请稍后再试");
  }

  const headers: http.OutgoingHttpHeaders = {
    authorization: `Bearer ${credential}`,
    "x-seekcloud-session": session.sessionId,
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  const target = new URL(`${SITE_GATEWAY_PATH}${url.pathname}${url.search}`, link.siteUrl);
  const client = target.protocol === "https:" ? https : http;
  const upstream = client.request(target, { method: req.method, headers });

  // 沙箱那头断了（dsh 取消、沙箱停了）：到主站的请求跟着断，主站再取消上游的模型流。
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  upstream.on("response", (up) => {
    const out: http.OutgoingHttpHeaders = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = up.headers[name];
      if (value !== undefined) out[name] = value;
    }
    res.writeHead(up.statusCode ?? 502, out);
    // 流式回复：一收到就发，不缓冲。
    res.flushHeaders();
    up.pipe(res);
    up.on("error", () => res.destroy());
  });
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    // 原始报错里有主站的地址，只记日志。
    console.error(`[model-gateway] 转发到主站失败：${error.message}`);
    reply(res, 502, "api_error", `连不上主站（${error.code ?? "unknown"}），请稍后再试`);
  });
  req.pipe(upstream);
}
