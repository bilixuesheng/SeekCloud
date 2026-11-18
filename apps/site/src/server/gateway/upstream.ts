import type { ProviderTarget } from "../ports";
import {
  type GatewayFailure,
  MAX_ERROR_BODY,
  readLimited,
  recordUpstreamFailure,
} from "./failures";
import type { GatewayDeps } from "./gateway";

/** 不分模型的接口（Files、联网搜索）往上游发一次请求。 */
export interface UpstreamRequest {
  method: string;
  /** 沙箱请求的路径，交给 ProviderTarget.url() 和 headers()。 */
  path: string;
  /** 加在地址后面的查询参数（网关自己拼的，不是沙箱的原样）。 */
  query?: URLSearchParams;
  /** 沙箱带来的请求头，由提供方挑白名单里的。 */
  incoming: Headers;
  contentType?: string;
  body?: BodyInit;
  signal: AbortSignal;
  timeoutMs: number;
}

export type UpstreamResult =
  /** 成功：读完响应体以后调 done()（超时一直算到读完为止）。 */
  | { ok: true; response: Response; target: ProviderTarget; done: () => void }
  | { ok: false; failure: GatewayFailure; target?: ProviderTarget };

/**
 * 依次试提供方：连不上、超时、上游回了错时把原始报错记下（failures.ts），再试下一个。
 * 请求体是一次性的流时（上传文件）只试第一个：流发出去就没了。
 */
export async function sendUpstream(
  deps: GatewayDeps,
  owner: { userId: string | null; sessionId: string | null },
  targets: ProviderTarget[],
  request: UpstreamRequest,
): Promise<UpstreamResult> {
  const doFetch = deps.modelFetch ?? fetch;
  const once = request.body instanceof ReadableStream;
  let last: UpstreamResult | undefined;
  for (const target of once ? targets.slice(0, 1) : targets) {
    const headers = target.headers(request.path, request.incoming);
    if (request.contentType) headers.set("content-type", request.contentType);
    const url = new URL(target.url(request.path));
    for (const [key, value] of request.query ?? []) url.searchParams.append(key, value);
    const abort = new AbortController();
    const onAbort = () => abort.abort(request.signal.reason);
    request.signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, request.timeoutMs);
    const done = () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    };
    try {
      const response = await doFetch(url, {
        method: request.method,
        headers,
        body: request.body,
        signal: abort.signal,
        // 上传的流原样转过去，不先读进内存。
        ...(once ? { duplex: "half" } : {}),
      } as RequestInit);
      if (response.ok) return { ok: true, response, target, done };
      const text = await readLimited(response, MAX_ERROR_BODY);
      done();
      last = {
        ok: false,
        target,
        failure: await recordUpstreamFailure(deps, owner, target.provider, {
          status: response.status,
          body: text,
          retryAfter: response.headers.get("retry-after") ?? undefined,
        }),
      };
    } catch (error) {
      done();
      if (request.signal.aborted) {
        return {
          ok: false,
          target,
          failure: { code: "internal", status: 499, message: "请求已取消" },
        };
      }
      last = {
        ok: false,
        target,
        failure: await recordUpstreamFailure(deps, owner, target.provider, {
          status: null,
          body: timedOut ? "等待上游响应超时" : String(error),
          code: timedOut ? "timeout" : "model_unavailable",
        }),
      };
    }
  }
  return (
    last ?? {
      ok: false,
      failure: {
        code: "model_unavailable",
        status: 503,
        message: "尚未设置模型服务的 API key，请管理员在“设置 → 模型”中填写",
      },
    }
  );
}
