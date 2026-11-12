export interface ApiError {
  code: string;
  message: string;
}

/**
 * 调接口。成功时返回 JSON（没有内容时返回 undefined），失败时抛出 ApiError。
 * 不带 body 是 GET，带 body 默认是 POST；要用别的方法（比如 PUT）时写在 method 里。
 */
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    throw (
      (data as { error?: ApiError } | undefined)?.error ?? {
        code: "network",
        message: "网络异常，请稍后重试",
      }
    );
  }
  return data as T;
}
