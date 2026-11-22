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

/**
 * 会话临时令牌：dsh 把它当 API key 用，放在哪里看协议（#188）：Anthropic（DeepSeek 的 Messages、Files）在
 * x-api-key，OpenAI 系和联网工具在 Authorization: Bearer，Gemini 在 x-goog-api-key 或者查询参数 key。
 */
function sessionToken(req: IncomingMessage, url: URL): string | undefined {
  for (const name of ["x-api-key", "x-goog-api-key"]) {
    const value = req.headers[name];
    if (typeof value === "string" && value) return value;
  }
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return url.searchParams.get("key") ?? undefined;
}

/**
 * 模型网关在宿主机这一半（#26，ADR 0003）：沙箱里的 dsh 把模型、Files、联网搜索和抓取的请求发到宿主机本地的
 * /v1/…（和 Git 代理同一个端口，dsh 的接口地址设成这个端口），宿主机核对会话临时令牌，换上自己的宿主机凭据和
 * 会话 ID，转给主站的 /api/gateway/v1/…；别的提供方的 /v1/providers/<id>/… 转给 /api/gateway/providers/<id>/…
 * （#188）。请求体和响应都边收边转，流式回复不攒整段。
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
  const token = sessionToken(req, url);
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
  // 别的提供方（#188）：/v1/providers/<id>/… 转给主站的透明转发 /api/gateway/providers/<id>/…；
  // 查询参数里的 key（Gemini 的写法，里面是会话令牌）不往主站带。
  url.searchParams.delete("key");
  const path = url.pathname.startsWith("/v1/providers/")
    ? url.pathname.slice("/v1".length)
    : url.pathname;
  const target = new URL(`${SITE_GATEWAY_PATH}${path}${url.search}`, link.siteUrl);
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
