import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";
import { handleMcpHttp } from "../github-tools/mcp";
import { gitObjectSigner, looksLikeGitObject, type SigningKey, sshSign } from "../signing/sshsig";
import type { ProxyCa } from "./ca";
import { parseReceivePack, type ReceivePackCommands, rejectionReport } from "./receive-pack";
import { checkCreateRef, checkRequest, GITHUB_HOSTS, pushRefusals } from "./rules";
import type { GitSession, GitSessions } from "./sessions";

/** 沙箱里 GH_TOKEN、GITHUB_TOKEN 的占位值：代理看到它就换成用户真正的令牌。 */
export const TOKEN_PLACEHOLDER = "proxy-injected";

export interface GitProxyOptions {
  sessions: GitSessions;
  ca: ProxyCa;
  signingKey: SigningKey;
  /** SeekCloud 账号的邮箱：只给提交者（或打标签的人）是它的对象签名。 */
  signerEmail: string;
  /** 每个 GitHub 域名转发到哪里，默认 https://域名。测试里换成本地的假 GitHub。 */
  upstreams?: Partial<Record<string, string>>;
}

interface Target {
  session: GitSession;
  host: string;
}

/** HTTPS 隧道只记会话令牌；每个请求都重新查会话，会话结束后隧道上的请求立刻不放行。 */
interface Tunnel {
  sessionToken: string;
  host: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** 要检查的请求体（推送命令、建引用的 JSON、待签名的对象）最多读这么多。 */
const MAX_INSPECT_BYTES = 1024 * 1024;

/**
 * Git 代理（ADR 0003）：沙箱访问 GitHub 的唯一通道。
 *
 * 沙箱的 HTTPS_PROXY 指向它，代理凭据是会话临时令牌。发往 GitHub 的 HTTPS 请求用自己的 CA 解密，
 * 按规则检查后换上用户的 GitHub 令牌再转发。同一个端口上还有给提交签名的 POST /sign，
 * 以及给 Agent 用的 GitHub 工具服务 POST /mcp。
 * 其他域名先一律拒绝；出站网络策略接上以后由它处理。
 */
export function createGitProxy(options: GitProxyOptions): http.Server {
  const tunnels = new WeakMap<Duplex, Tunnel>();

  // 解密后的请求交给这个不监听端口的服务器处理。
  const inner = http.createServer((req, res) => {
    const tunnel = tunnels.get(req.socket);
    const session = tunnel && options.sessions.byToken(tunnel.sessionToken);
    if (!tunnel || !session) {
      reply(res, 403, "会话已经结束，代理不再放行");
      req.socket.destroy();
      return;
    }
    guard(res, forward(options, { session, host: tunnel.host }, req, res));
  });

  const outer = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/")) {
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/mcp") {
        const apiBase = options.upstreams?.["api.github.com"];
        return guard(res, handleMcpHttp(options.sessions, req, res, apiBase));
      }
      return guard(res, handleSign(options, req, res));
    }
    // 明文 HTTP 的代理请求（只在测试和极少数工具里出现）。
    const session = sessionFromProxyAuth(options.sessions, req);
    if (!session) return proxyAuthRequired(res);
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return reply(res, 400, "看不懂的地址");
    }
    if (!isGitHubHost(host)) return reply(res, 403, otherHostMessage(host));
    guard(res, forward(options, { session, host }, req, res));
  });

  outer.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const session = sessionFromProxyAuth(options.sessions, req);
    if (!session) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="SeekCloud"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const [host = "", port = "443"] = (req.url ?? "").split(":");
    if (!isGitHubHost(host) || port !== "443") {
      const body = Buffer.from(otherHostMessage(host));
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      );
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    const tls = new TLSSocket(socket, {
      isServer: true,
      secureContext: options.ca.contextFor(host),
    });
    tls.on("error", () => tls.destroy());
    tunnels.set(tls, { sessionToken: session.sessionToken, host });
    inner.emit("connection", tls);
  });

  return outer;
}

const isGitHubHost = (host: string) => (GITHUB_HOSTS as readonly string[]).includes(host);

const otherHostMessage = (host: string) => `Git 代理只处理 GitHub 的地址，${host} 不归它管。`;

/** 处理请求时出了意外，回个 500 或者断开这个连接，不能让整个宿主机进程退出。 */
function guard(res: ServerResponse, work: Promise<unknown>) {
  work.catch((error: unknown) => {
    console.error("Git 代理出错", error);
    if (!res.headersSent) reply(res, 500, "代理出错了");
    else res.destroy();
  });
}

function reply(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${message}\n`);
}

function proxyAuthRequired(res: ServerResponse) {
  res.writeHead(407, { "proxy-authenticate": 'Basic realm="SeekCloud"' });
  res.end();
}

/** Basic 认证头里的用户名和密码；不是 Basic 就返回 undefined。 */
function decodeBasic(header: string | undefined) {
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  return colon === -1
    ? { user: decoded, password: "" }
    : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** 代理凭据：Basic 认证，密码（或用户名）是会话临时令牌。 */
function sessionFromProxyAuth(sessions: GitSessions, req: IncomingMessage) {
  const basic = decodeBasic(req.headers["proxy-authorization"]);
  return basic && sessions.byToken(basic.password || basic.user);
}

/** 沙箱发的请求带着占位令牌（或者没带），就换成用户的令牌；用户自己设的令牌原样转发。 */
function usesPlaceholder(authorization: string | undefined): boolean {
  if (!authorization || authorization.includes(TOKEN_PLACEHOLDER)) return true;
  const basic = decodeBasic(authorization);
  return basic !== undefined && `${basic.user}:${basic.password}`.includes(TOKEN_PLACEHOLDER);
}

/** 去掉只对这一跳有效的头（还有 Host），剩下的原样转发。 */
function copyHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) out[name] = value;
  }
  return out;
}

async function forward(
  options: GitProxyOptions,
  target: Target,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url ?? "/", `https://${target.host}`);
  const method = req.method ?? "GET";
  const decision = checkRequest(target.session.repos, {
    host: target.host,
    method,
    path: url.pathname,
    query: url.searchParams,
  });
  if (!decision.allow) return reply(res, decision.status, decision.message);

  const headers = copyHeaders(req.headers);
  if (usesPlaceholder(req.headers.authorization)) {
    const token = target.session.githubToken;
    if (!token) return reply(res, 503, "GitHub 令牌还没有下发到这台宿主机，请稍后再试。");
    headers.authorization =
      target.host === "api.github.com"
        ? `Bearer ${token}`
        : `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }

  let prefix: Buffer | undefined;
  try {
    if (decision.inspect === "push") {
      const peeked = await peekPushCommands(req);
      const reasons = pushRefusals(peeked.commands.updates);
      if (reasons.size > 0) return refusePush(req, res, peeked.commands, reasons);
      prefix = peeked.data;
    }
    if (decision.inspect === "create-ref") {
      const body = (await readAll(req, MAX_INSPECT_BYTES)).toString();
      const check = checkCreateRef(body);
      if (!check.allow) return reply(res, check.status, check.message);
      // 转发检查过的那份：重新序列化，免得重复的键让代理和 GitHub 读出不同的 ref。
      prefix = Buffer.from(JSON.stringify(JSON.parse(body)));
      headers["content-length"] = String(prefix.length);
    }
  } catch (error) {
    return reply(res, 400, `代理看不懂这个请求：${(error as Error).message}`);
  }

  const base = options.upstreams?.[target.host] ?? `https://${target.host}`;
  const upstreamUrl = new URL(`${base}${url.pathname}${url.search}`);
  const client = upstreamUrl.protocol === "https:" ? https : http;
  const upstream = client.request(upstreamUrl, { method, headers });
  upstream.on("response", (up) => {
    res.writeHead(up.statusCode ?? 502, copyHeaders(up.headers));
    up.pipe(res);
  });
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    // 原始报错里有上游的地址（以后可能走出站代理），只记日志；沙箱里只看到错误码（ADR 0007）。
    console.error(`[git-proxy] 连不上 ${target.host}：${error.message}`);
    if (!res.headersSent)
      reply(res, 502, `连不上 GitHub（${error.code ?? "unknown"}），请稍后再试。`);
    else res.destroy();
  });
  if (prefix) upstream.write(prefix);
  req.pipe(upstream);
}

/** 拒绝整次推送。git 支持 report-status 时按它回复，git 会显示每个引用被拒的原因。 */
function refusePush(
  req: IncomingMessage,
  res: ServerResponse,
  commands: ReceivePackCommands,
  reasons: Map<string, string>,
) {
  req.resume();
  // report-status 和 report-status-v2 的 ok / ng 行格式一样。
  if (!commands.capabilities.some((c) => c.startsWith("report-status"))) {
    return reply(res, 403, [...new Set(reasons.values())].join(" "));
  }
  res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
  res.end(rejectionReport(commands, reasons));
}

/** 读推送请求体的开头，直到引用命令读全；读到的数据原样返回，剩下的（打包数据）留在流里。 */
function peekPushCommands(
  req: IncomingMessage,
): Promise<{ data: Buffer; commands: ReceivePackCommands }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", reject);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      try {
        const data = Buffer.concat(chunks);
        const commands = parseReceivePack(data);
        if (commands) {
          cleanup();
          req.pause();
          resolve({ data, commands });
        } else if (size > MAX_INSPECT_BYTES) {
          throw new Error("推送命令太长");
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("推送请求不完整"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", reject);
  });
}

async function readAll(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("请求体太大");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** 宿主机给沙箱提供的签名服务：POST /sign?namespace=git，会话令牌放在 Authorization 里。 */
async function handleSign(options: GitProxyOptions, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/sign" || req.method !== "POST") return reply(res, 404, "没有这个地址");
  const auth = req.headers.authorization ?? "";
  const session = auth.startsWith("Bearer ") ? options.sessions.byToken(auth.slice(7)) : undefined;
  if (!session) return reply(res, 401, "会话令牌不对，或者会话已经结束");
  if (url.searchParams.get("namespace") !== "git") {
    return reply(res, 400, "只给 git 的提交和标签签名（namespace=git）");
  }
  let message: Buffer;
  try {
    message = await readAll(req, MAX_INSPECT_BYTES);
  } catch (error) {
    return reply(res, 413, (error as Error).message);
  }
  if (!looksLikeGitObject(message)) return reply(res, 400, "只给 git 的提交和标签对象签名");
  const signer = gitObjectSigner(message);
  if (signer !== options.signerEmail) {
    return reply(
      res,
      403,
      `只给提交者是 SeekCloud 账号（${options.signerEmail}）的提交签名，这个提交的提交者是 ${signer ?? "未知"}`,
    );
  }
  // 审计：哪个会话签了哪个对象。
  console.log(
    JSON.stringify({
      event: "git.sign",
      sessionId: session.sessionId,
      object: createHash("sha256").update(message).digest("hex"),
    }),
  );
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(sshSign(options.signingKey, "git", message));
}
