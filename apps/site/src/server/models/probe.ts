import type { ModelProtocol } from "@seekcloud/protocol";
import { authHeaders } from "../gateway/trunk";
import { redactSecrets } from "./mask";

/**
 * "获取可用模型"（#113，照 dsh 的模型探测）：用表单里的地址、协议、key 问端点有哪些模型。
 * - OpenAI 兼容的 GET /models、Anthropic 的 GET /v1/models、Gemini 的 GET /models；
 * - 读 data 数组或者 models（数组或对象）；两个都没有时报"格式不对"，让管理员手动填；
 * - 不跟重定向；报错里认得出来的密钥打码。保存之前什么都不存。
 */

export interface ProbedModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export type ProbeResult =
  | { ok: true; models: ProbedModel[] }
  | { ok: false; status: number | null; message: string };

const PROBE_TIMEOUT_MS = 10_000;

/** 列模型的地址：Anthropic 的在 /v1/models，别的在 /models。 */
export function listingUrl(protocol: ModelProtocol, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return protocol === "anthropic-messages" ? `${base}/v1/models` : `${base}/models`;
}

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const positive = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** 读端点回的列表。读不懂时为空。 */
export function decodeModelList(body: unknown): ProbedModel[] | undefined {
  const b = fieldsOf(body);
  if (!b) return undefined;
  const fromEntry = (entry: unknown, key?: string): ProbedModel | undefined => {
    const e = fieldsOf(entry);
    // Gemini 的 name 是 models/xxx；不能生成文字的（嵌入模型这些）不要
    const methods = e?.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes("generateContent")) return undefined;
    // models 是对象时键就是模型 ID；别的时候看 id，没有再看 name（Gemini 的 name 是 models/xxx）
    const raw = key ?? text(e?.id) ?? text(e?.name);
    if (!raw) return undefined;
    const id = raw.replace(/^models\//, "");
    const name =
      text(e?.display_name) ??
      text(e?.displayName) ??
      (key || text(e?.id) ? text(e?.name) : undefined);
    const contextWindow =
      positive(e?.context_length) ?? positive(e?.context_window) ?? positive(e?.inputTokenLimit);
    const maxTokens = positive(e?.max_output_tokens) ?? positive(e?.outputTokenLimit);
    return {
      id,
      ...(name && name !== id ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    };
  };
  let entries: Array<ProbedModel | undefined>;
  if (Array.isArray(b.data)) entries = b.data.map((e) => fromEntry(e));
  else if (Array.isArray(b.models)) entries = b.models.map((e) => fromEntry(e));
  else if (fieldsOf(b.models)) {
    entries = Object.entries(b.models as Fields).map(([key, e]) => fromEntry(e, key));
  } else return undefined;
  const seen = new Set<string>();
  return entries.filter((m): m is ProbedModel => {
    if (!m || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export async function probeModels(
  deps: { modelFetch?: typeof fetch; version: string },
  input: { protocol: ModelProtocol; baseUrl: string; apiKey?: string; url?: string },
): Promise<ProbeResult> {
  const doFetch = deps.modelFetch ?? fetch;
  const url = input.url ?? listingUrl(input.protocol, input.baseUrl);
  // 没有 key 也能问（本机的 Ollama 这类不要 key）：不带认证头
  const headers = input.apiKey
    ? authHeaders(input.protocol, input.apiKey, new Headers(), deps.version)
    : new Headers({ "user-agent": `SeekCloud/${deps.version}` });
  let response: Response;
  try {
    response = await doFetch(
      // Gemini 一页默认只有 50 个
      input.protocol === "google-generative-ai" ? `${url}?pageSize=1000` : url,
      { headers, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      status: null,
      message: timedOut
        ? "连接超时，请检查接口地址"
        : `无法连接：${redactSecrets(String(error), input.apiKey)}`,
    };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, status: response.status, message: "接口要求重定向，请填写重定向后的地址" };
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? "，请检查 API key" : "";
    return {
      ok: false,
      status: response.status,
      message: `接口返回 ${response.status}${hint}：${redactSecrets(body.slice(0, 300), input.apiKey)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const models = decodeModelList(parsed);
  if (!models) {
    return {
      ok: false,
      status: response.status,
      message: "接口返回的列表既没有 data 数组也没有 models 对象，请手动填写模型",
    };
  }
  return { ok: true, models };
}
