export interface ApiError {
  code: string;
  /** 主站给的说明（中文）；界面上优先用文案目录里按 code 写好的（i18n/errors.ts 的 errorText）。 */
  message: string;
  /** 被频率限制时还要等的秒数（响应的 Retry-After）。 */
  retryAfter?: number;
}

/**
 * 调接口。成功时返回 JSON（没有内容时返回 undefined），失败时抛出 ApiError。
 * 不带 body 是 GET，带 body 默认是 POST；要用别的方法（比如 PUT、PATCH、DELETE）时写在 method 里（DELETE 传个空对象）。
 */
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const error = (data as { error?: ApiError } | undefined)?.error ?? {
      code: "network",
      message: "网络异常，请稍后重试",
    };
    const retryAfter = Number(res.headers.get("retry-after"));
    throw retryAfter > 0 ? { ...error, retryAfter } : error;
  }
  return data as T;
}
