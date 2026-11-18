import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";
import type { AppDeps } from "../app";
import {
  guardedLookup,
  type OutboundNetwork,
  PrivateAddressError,
  publicNetwork,
} from "../network/address";
import type { WebToolCall } from "../ports";
import { errorResponse } from "./failures";
import { htmlToMarkdown } from "./html";

/** 一次抓取（连接加读完）最多这么久。 */
export const WEB_FETCH_TIMEOUT_MS = 30_000;
/** 响应体（解压以后）最多读这么多。 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** 给 Agent 的内容最多这么长，再长的截掉。 */
const MAX_CONTENT_CHARS = 100_000;
const MAX_URL_CHARS = 8192;

const PRIVATE_ADDRESS = "网关不抓取内网、本机和云服务元数据这类地址";

export type FetchDeps = Pick<AppDeps, "db" | "modelAdmission" | "version"> & {
  /** 怎么解析域名、哪些地址能连。测试里换成本地的假网站。 */
  outboundNetwork?: OutboundNetwork;
  webFetchTimeoutMs?: number;
};

/** 抓取出错，带着给 Agent 看的说明（里面没有主站自己的信息）。 */
class FetchProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const problem = (status: number, message: string) =>
  errorResponse({ code: status === 504 ? "timeout" : "model_rejected", status, message });

/**
 * 网页抓取（POST /v1/tools/fetch，DeepSeek 抓取接口的格式：请求 { url }，回复 { content }）。
 * 主站替沙箱去取这个网址（#26 的 2026-11-15 评论）：
 *
 * - 只取 http 和 https，网址里不能带用户名和密码；
 * - 不受会话所用环境的网络策略约束（照 Claude Code：搜索和抓取是服务端的工具，2026-11-18 用户定的）；
 * - 按解析后的 IP 判断，不连内网、回环和元数据地址，连的就是判断时解析出来的那个地址（network/address.ts）；
 * - 不跟着重定向跳过去：告诉 Agent 重定向到了哪里，要不要抓由它再发一次（照样过上面的检查）；
 * - 响应有大小上限和超时；网页转成 Markdown，文本原样，别的（图片、压缩包）不收；
 * - 过准入，每次抓取记一条用量（按次数，提供方为空）。
 */
export async function webFetch(
  deps: FetchDeps,
  call: WebToolCall,
  request: { body: Record<string, unknown>; signal: AbortSignal },
): Promise<Response> {
  const raw = request.body.url;
  if (typeof raw !== "string" || !raw.trim()) return problem(400, "要抓取的网址不能为空");
  if (raw.length > MAX_URL_CHARS) return problem(400, `网址最长 ${MAX_URL_CHARS} 个字符`);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return problem(400, "看不懂这个网址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return problem(400, "只抓取 http 和 https 的网址");
  }
  if (url.username || url.password) return problem(400, "网址里不能带用户名和密码");
  url.hash = "";
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;

  const network = deps.outboundNetwork ?? publicNetwork;
  // 直接写 IP 的网址不经过域名解析，在这里判断。
  if (isIP(host) && !network.allowAddress(host)) return problem(403, PRIVATE_ADDRESS);

  const admitted = await deps.modelAdmission.admitWebTool(call);
  if (!admitted.ok) return problem(429, admitted.message);
  const record = async (ok: boolean) => {
    try {
      await deps.modelAdmission.recordWebTool({ ...call, provider: null, ok });
    } catch (error) {
      console.error("模型网关：记联网工具的用量失败", error);
    }
  };

  const timeoutMs = deps.webFetchTimeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const content = await fetchPage(
      url,
      network,
      deps.version,
      AbortSignal.any([request.signal, deadline]),
    );
    await record(true);
    return new Response(JSON.stringify({ content }), {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    await record(false);
    if (request.signal.aborted) {
      return errorResponse({ code: "internal", status: 499, message: "请求已取消" });
    }
    if (deadline.aborted) {
      return problem(504, `等待目标网站超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    return problemFor(error);
  }
}

function problemFor(error: unknown): Response {
  if (error instanceof FetchProblem) return problem(error.status, error.message);
  const code = (error as NodeJS.ErrnoException)?.code ?? "unknown";
  if (error instanceof PrivateAddressError || code === "EPRIVATEADDRESS") {
    return problem(403, PRIVATE_ADDRESS);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") {
    return problem(502, `找不到这个域名（${code}）`);
  }
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code)) {
    return problem(502, `目标网站的证书验证不通过（${code}）`);
  }
  return problem(502, `连不上目标网站（${code}）`);
}

/** 取一个网页，返回给 Agent 的内容。 */
async function fetchPage(
  url: URL,
  network: OutboundNetwork,
  version: string,
  signal: AbortSignal,
): Promise<string> {
  const client = url.protocol === "https:" ? https : http;
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": `Mozilla/5.0 (compatible; SeekCloud/${version})`,
          accept:
            "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        // 每次都按这次解析、检查过的地址去连，不复用别的请求留下的连接。
        lookup: guardedLookup(network) as unknown as LookupFunction,
        agent: false,
        signal,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });

  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    res.destroy();
    const location = res.headers.location;
    if (!location)
      throw new FetchProblem(502, `目标网站回了状态码 ${status}，但没有说重定向到哪里`);
    let target = location;
    try {
      target = new URL(location, url).href;
    } catch {
      // 看不懂的地址原样告诉 Agent
    }
    return `这个网址重定向到了 ${target}（状态码 ${status}）。网关不跟着跳转；需要的话请直接抓取这个地址。`;
  }

  const contentType = String(res.headers["content-type"] ?? "");
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const { body, truncated } = await readBody(res);
  const kind = classify(type, body);
  if (kind === "binary") {
    throw new FetchProblem(
      415,
      `这个网址的内容不是文本（${type || "未知类型"}），网关只抓取网页和文本`,
    );
  }
  const text = decode(body, contentType, kind === "html");
  let content = kind === "html" ? htmlToMarkdown(text, url.href).markdown : text;
  let cut = truncated;
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS);
    cut = true;
  }
  return [
    status >= 400 ? `（目标网站返回了状态码 ${status}）\n\n` : "",
    content,
    cut ? "\n\n（内容太长，后面的已经截掉）" : "",
  ].join("");
}

/** 读响应体（按 content-encoding 解压），解压以后最多 MAX_BODY_BYTES：压缩炸弹也只读这么多。 */
async function readBody(res: IncomingMessage): Promise<{ body: Buffer; truncated: boolean }> {
  const encoding = String(res.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  let decompress: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | undefined;
  if (encoding === "gzip" || encoding === "x-gzip") decompress = zlib.createGunzip();
  else if (encoding === "deflate") decompress = zlib.createInflate();
  else if (encoding === "br") decompress = zlib.createBrotliDecompress();
  else if (encoding !== "" && encoding !== "identity") {
    res.destroy();
    throw new FetchProblem(502, `目标网站用了不认识的压缩方式（${encoding}）`);
  }
  const stream: Readable = decompress ? pipeline(res, decompress, () => undefined) : res;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      if (size + buf.length > MAX_BODY_BYTES) {
        chunks.push(buf.subarray(0, MAX_BODY_BYTES - size));
        truncated = true;
        break;
      }
      chunks.push(buf);
      size += buf.length;
    }
  } finally {
    res.destroy();
  }
  return { body: Buffer.concat(chunks), truncated };
}

const TEXT_TYPES =
  /^application\/(json|xml|javascript|x-javascript|ecmascript|x-yaml|yaml|toml|x-sh|graphql|sql|x-ndjson)$/;

/** 网页、文本，还是别的（不收）。没写类型的看开头有没有 NUL 字节。 */
function classify(type: string, body: Buffer): "html" | "text" | "binary" {
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type.startsWith("text/") || TEXT_TYPES.test(type) || /\+(json|xml)$/.test(type)) {
    return "text";
  }
  if (type === "" || type === "application/octet-stream") {
    const head = body.subarray(0, 1024);
    if (head.includes(0)) return "binary";
    const start = head.toString("latin1").trimStart().toLowerCase();
    return start.startsWith("<!doctype html") || start.startsWith("<html") ? "html" : "text";
  }
  return "binary";
}

/** 按 content-type 里的字符集解码，网页再看 <meta charset>；不认识的字符集按 UTF-8。 */
function decode(body: Buffer, contentType: string, html: boolean): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset && html) {
    const head = body.subarray(0, 4096).toString("latin1");
    charset = /<meta[^>]{0,200}?charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
