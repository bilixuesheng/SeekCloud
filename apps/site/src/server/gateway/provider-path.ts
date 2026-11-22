import type { ModelProtocol } from "@seekcloud/protocol";

/**
 * 透明转发（/api/gateway/providers/{id}/…）的路径：只转给这个提供方保存的地址下面的路径。
 * 路径里的 ..、.、编码过的斜杠和反斜杠一律拒绝（不让拼出地址之外的路径）。
 */
export function safeProviderPath(raw: string): string | undefined {
  if (!raw.startsWith("/") || raw.length > 1000) return undefined;
  if (/%2f|%5c|\\/i.test(raw)) return undefined;
  if (!/^[A-Za-z0-9._~:@!$&'()*+,;=%/-]+$/.test(raw)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const segments = decoded.split("/").slice(1);
  if (segments.some((s) => s === ".." || s === ".")) return undefined;
  return raw;
}

/** 请求说的是哪种协议：按各家 SDK 拼出来的路径认。认不出来的（列模型、上传文件这些）不转。 */
export function protocolOfPath(path: string): ModelProtocol | undefined {
  if (/\/chat\/completions$/.test(path)) return "openai-completions";
  if (/\/responses$/.test(path)) return "openai-responses";
  if (/\/messages(\/count_tokens)?$/.test(path)) return "anthropic-messages";
  if (/\/models\/[^/]+:(generateContent|streamGenerateContent|countTokens)$/.test(path)) {
    return "google-generative-ai";
  }
  return undefined;
}

/** 请求的是哪个模型：Gemini 写在路径里，别的写在请求体的 model 里。 */
export function modelOfRequest(
  protocol: ModelProtocol,
  path: string,
  body: Record<string, unknown>,
): string | undefined {
  if (protocol === "google-generative-ai") {
    const match = /\/models\/([^/:]+):[A-Za-z]+$/.exec(path)?.[1];
    return match ? decodeURIComponent(match) : undefined;
  }
  return typeof body.model === "string" && body.model ? body.model : undefined;
}

/** 转给上游的查询参数：Gemini 的 ?key= 换成认证头里的真 key，不往上游带沙箱里的假 key。 */
export function upstreamSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("key");
  const out = params.toString();
  return out ? `?${out}` : "";
}
