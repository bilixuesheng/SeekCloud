import { randomBytes } from "node:crypto";
import type { ErrorCode } from "@seekcloud/protocol";
import type { AppDeps } from "../app";
import { upstreamErrors } from "../db/schema";
import { markProviderKeyRejected } from "../models/providers";

/** 上游的报错最多存这么长。 */
export const MAX_ERROR_BODY = 16 * 1024;

/** 给沙箱、给平台调用方看的一次出错：我们自己写的说明、状态码和参考号，不带上游的任何文字。 */
export interface GatewayFailure {
  code: ErrorCode;
  status: number;
  /** 上游出错时才有；网关自己拒绝（没 key、不放行）时没有。 */
  ref?: string;
  message: string;
  retryAfter?: string;
}

export class GatewayError extends Error {
  constructor(readonly failure: GatewayFailure) {
    super(failure.message);
  }
}

export const DESCRIPTIONS: Record<ErrorCode, string> = {
  model_unavailable: "模型服务暂时不可用",
  model_rate_limited: "模型服务限流",
  model_rejected: "模型服务拒绝了请求",
  context_too_long: "对话超出模型的上下文长度",
  timeout: "等待模型服务超时",
  sandbox_unavailable: "无法创建沙箱",
  repo_clone_failed: "克隆仓库失败",
  internal: "模型网关出错",
};

/** 上游的状态码（和响应体）归到哪一类。只用来分类，响应体本身不往下传。 */
export function classify(status: number | null, body: string): ErrorCode {
  if (status === null) return "model_unavailable";
  if (status === 429) return "model_rate_limited";
  if (status >= 500) return "model_unavailable";
  if (status === 400 && /context|too long|maximum.*tokens|prompt is too long/i.test(body)) {
    return "context_too_long";
  }
  return "model_rejected";
}

/** Anthropic 的错误类型，沙箱里的 dsh 按它决定要不要重试。 */
function anthropicErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529 || status === 503) return "overloaded_error";
  return "api_error";
}

/** Anthropic 格式的错误响应。只有我们自己写的说明。 */
export function errorResponse(failure: GatewayFailure): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (failure.retryAfter) headers.set("retry-after", failure.retryAfter);
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: anthropicErrorType(failure.status), message: failure.message },
    }),
    { status: failure.status, headers },
  );
}

const REF_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
/** 参考号：我们自己随机生成的，不用上游的请求编号。 */
export function newRef(): string {
  return [...randomBytes(8)].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
}

/** 上游出了什么错：状态码（连不上时为空）、响应体，以及网关自己判断出的类别（不给就按状态码和响应体分）。 */
export interface UpstreamRaw {
  status: number | null;
  body: string;
  retryAfter?: string;
  code?: ErrorCode;
}

/**
 * 记下一次上游出错：原始报错按参考号存库（只给管理员看），返回给调用方的只有说明、状态码和参考号。
 * 上游说 key 不对（401、403）时记下来，设置里提示管理员检查。
 */
export async function recordUpstreamFailure(
  deps: Pick<AppDeps, "db" | "clock">,
  owner: { userId: string | null; sessionId: string | null },
  provider: string,
  raw: UpstreamRaw,
): Promise<GatewayFailure> {
  const ref = newRef();
  const code = raw.code ?? classify(raw.status, raw.body);
  const status =
    raw.status !== null && raw.status >= 400 && raw.status <= 599
      ? raw.status
      : code === "timeout"
        ? 504
        : 502;
  console.warn(`模型网关：提供方 ${provider} 出错（${raw.status ?? "连不上"}，参考号 ${ref}）`);
  await deps.db.insert(upstreamErrors).values({
    ref,
    userId: owner.userId,
    sessionId: owner.sessionId,
    provider,
    code,
    status: raw.status,
    body: raw.body.slice(0, MAX_ERROR_BODY),
    createdAt: deps.clock.now(),
  });
  if (raw.status === 401 || raw.status === 403) await markProviderKeyRejected(deps, provider);
  return {
    code,
    status,
    ref,
    message: `${DESCRIPTIONS[code]}（${status} · 参考号 ${ref}）`,
    retryAfter: raw.retryAfter,
  };
}

/** 读上游响应体的开头（报错只存这么多），读完把剩下的丢掉。 */
export async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}
