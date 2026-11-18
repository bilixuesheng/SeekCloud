import type { TestApp } from "./test-app";

/**
 * 扮演宿主机调模型网关（/api/gateway/...）：带上假宿主机的凭据和会话 ID，和真的宿主机转发过来的一样。
 * body 是对象时按 JSON 发；FormData 原样发（浏览器那样自己带 boundary）。
 */
export async function gatewayRequest(
  t: TestApp,
  sessionId: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${t.host.credential}`,
    "x-seekcloud-session": sessionId,
    ...init.headers,
  };
  let body: BodyInit | undefined;
  if (init.body instanceof FormData || typeof init.body === "string") body = init.body;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] ??= "application/json";
  }
  return t.request(`/api/gateway${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  });
}

/** 发起一个会话，等假宿主机把沙箱准备好，返回会话的 ID（宿主机那边的）和短 ID。 */
export async function startSession(
  t: TestApp,
  browser: { post(path: string, body?: unknown): Promise<Response> },
  repo: string,
  text = "看看",
): Promise<{ sessionId: string; shortId: string }> {
  const res = await browser.post("/api/sessions", { repo, baseBranch: "main", text });
  const { shortId } = (await res.json()) as { shortId: string };
  await t.host.idle();
  return { sessionId: t.host.last("prepare_sandbox").sessionId, shortId };
}
