import type { WebToolCall } from "../ports";
import { errorResponse, recordUpstreamFailure } from "./failures";
import type { GatewayDeps } from "./gateway";
import { sendUpstream } from "./upstream";

/** 一次搜索最多等这么久。 */
const SEARCH_TIMEOUT_MS = 60_000;
/** 搜索结果最多这么多条（DeepSeek 搜索接口的上限）。 */
const MAX_SEARCH_COUNT = 50;
const DEFAULT_SEARCH_COUNT = 10;
const MAX_QUERY_CHARS = 2000;
/** 触发这次搜索的那句话（DeepSeek 搜索接口的 ori_question），接口最多收这么长。 */
const MAX_QUESTION_CHARS = 128;

const reject = (status: number, message: string) =>
  errorResponse({ code: "model_rejected", status, message });

/** 搜索结果的一条只留这几个字段，别的（上游的编号、打分这些）一律不带回沙箱。 */
const RESULT_FIELDS = ["url", "title", "snippet", "summary", "content"] as const;

function cleanResult(item: unknown): Record<string, unknown> | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const row = item as Record<string, unknown>;
  if (typeof row.url !== "string" || row.url.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const field of RESULT_FIELDS) {
    if (typeof row[field] === "string") out[field] = row[field];
  }
  out.title ??= "";
  out.snippet ??= "";
  // 发布日期：没有时是 null（和 DeepSeek 的格式一样，dsh 按这个读）。
  out.date = typeof row.date === "string" ? row.date : null;
  return out;
}

/**
 * 联网搜索（POST /v1/tools/search，DeepSeek 搜索接口的格式，dsh 的 deepseek-search-api 调的就是它）。
 * 请求体只转 query、count、need_content、ori_question；转给提供方路由给的搜索接口，结果只留几个字段。
 * 过准入、记一次用量（按次数）。上游出错时和 Messages 一样只回说明、状态码和参考号。
 */
export async function webSearch(
  deps: GatewayDeps,
  call: WebToolCall,
  request: { headers: Headers; body: unknown; signal: AbortSignal },
): Promise<Response> {
  const body = request.body as Record<string, unknown>;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return reject(400, "搜索词不能为空");
  if (query.length > MAX_QUERY_CHARS) return reject(400, `搜索词最多 ${MAX_QUERY_CHARS} 个字`);
  const count = body.count ?? DEFAULT_SEARCH_COUNT;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_SEARCH_COUNT) {
    return reject(400, `count 要是 1 到 ${MAX_SEARCH_COUNT} 之间的整数`);
  }
  if (body.need_content !== undefined && typeof body.need_content !== "boolean") {
    return reject(400, "need_content 要是 true 或 false");
  }
  const upstreamBody: Record<string, unknown> = {
    query,
    count,
    need_content: body.need_content ?? false,
  };
  if (typeof body.ori_question === "string" && body.ori_question.trim()) {
    upstreamBody.ori_question = body.ori_question.trim().slice(0, MAX_QUESTION_CHARS);
  }

  const record = async (provider: string | null, ok: boolean) => {
    try {
      await deps.modelAdmission.recordWebTool({ ...call, provider, ok });
    } catch (error) {
      console.error("模型网关：记联网工具的用量失败", error);
    }
  };
  const admitted = await deps.modelAdmission.admitWebTool(call);
  if (!admitted.ok) return reject(429, admitted.message);
  const targets = await deps.providerRouting.service({
    service: "web_search",
    userId: call.userId,
    sessionId: call.sessionId,
  });
  const sent = await sendUpstream(deps, call, targets, {
    method: "POST",
    path: "/v1/tools/search",
    incoming: request.headers,
    contentType: "application/json",
    body: JSON.stringify(upstreamBody),
    signal: request.signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  if (!sent.ok) {
    if (sent.target) await record(sent.target.provider, false);
    return errorResponse(sent.failure);
  }
  let results: Record<string, unknown>[];
  try {
    const payload = (await sent.response.json()) as { results?: unknown };
    if (!Array.isArray(payload.results)) throw new Error("没有 results");
    results = payload.results.map(cleanResult).filter((r) => r !== undefined);
  } catch (error) {
    await record(sent.target.provider, false);
    const failure = await recordUpstreamFailure(deps, call, sent.target.provider, {
      status: null,
      body: `搜索接口返回的内容看不懂：${String(error)}`,
      code: "model_unavailable",
    });
    return errorResponse(failure);
  } finally {
    sent.done();
  }
  await record(sent.target.provider, true);
  return new Response(JSON.stringify({ results }), {
    headers: { "content-type": "application/json" },
  });
}
