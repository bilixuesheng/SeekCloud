import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProxyCa } from "../git-proxy/ca";
import { createGitProxy } from "../git-proxy/proxy";
import { GitSessions } from "../git-proxy/sessions";
import { loadSigningKey } from "../signing/sshsig";

const SESSION_TOKEN = "sess_model_123";
const CREDENTIAL = "host-credential-abc";

interface SiteRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  closedEarly: boolean;
}

/** 假的主站：记下收到的请求；/v1/messages 先发一个事件，等测试放行再发剩下的。 */
function startFakeSite() {
  const requests: SiteRequest[] = [];
  let release: (() => void) | undefined;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    const entry: SiteRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: Buffer.alloc(0),
      closedEarly: false,
    };
    requests.push(entry);
    res.on("close", () => {
      if (!res.writableFinished) entry.closedEarly = true;
    });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      entry.body = Buffer.concat(chunks);
      if (req.url?.startsWith("/api/gateway/v1/messages")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "x-site-internal": "secret",
          "retry-after": "3",
        });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        release = () => {
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        };
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  return {
    requests,
    release: () => release?.(),
    server,
    async listen() {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
  };
}

describe("模型网关的宿主机这一半：沙箱的 /v1/… 转给主站", () => {
  const site = startFakeSite();
  const sessions = new GitSessions();
  let credential: string | undefined = CREDENTIAL;
  let proxy: http.Server;
  let proxyUrl: string;

  beforeAll(async () => {
    const siteUrl = await site.listen();
    proxy = createGitProxy({
      sessions,
      ca: new ProxyCa(mkdtempSync(join(tmpdir(), "proxy-ca-"))),
      signingKey: loadSigningKey(
        generateKeyPairSync("ed25519")
          .privateKey.export({ format: "pem", type: "pkcs8" })
          .toString(),
        "seekcloud",
      ),
      signerEmail: "bot@seekcloud.test",
      modelGateway: { siteUrl, credential: () => credential },
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    credential = CREDENTIAL;
    sessions.register({ sessionId: "s1", sessionToken: SESSION_TOKEN, repos: [] });
  });
  afterAll(async () => {
    await new Promise<void>((done) => proxy.close(() => done()));
    await new Promise<void>((done) => site.server.close(() => done()));
  });

  /** 不经过 fetch（它会把 .. 规整掉），按原样发路径。 */
  const raw = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(`${proxyUrl}${path}`, { method: "GET", headers, path }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  it("Messages：换上宿主机凭据和会话 ID，不带会话令牌和 dsh 夹带的请求头；流式回复边收边转", async () => {
    const before = site.requests.length;
    const res = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": SESSION_TOKEN,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "files-api-2025-04-14",
        "x-deepseek-harness-user-id": "anon-1",
        cookie: "a=b",
        "user-agent": "dsh/0.2.2",
      },
      body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
    });
    expect(res.status).toBe(200);
    // 主站还没发完，第一个事件已经到了
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("message_start");
    site.release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain("message_stop");

    const got = site.requests[before] as SiteRequest;
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/api/gateway/v1/messages");
    expect(got.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(got.headers["x-seekcloud-session"]).toBe("s1");
    expect(got.headers["anthropic-version"]).toBe("2023-06-01");
    expect(got.headers["anthropic-beta"]).toBe("files-api-2025-04-14");
    for (const name of ["x-api-key", "x-deepseek-harness-user-id", "cookie"]) {
      expect(got.headers[name], name).toBeUndefined();
    }
    expect(got.headers["user-agent"] ?? "").not.toContain("dsh");
    expect(JSON.parse(got.body.toString())).toEqual({ model: "deepseek-flash", messages: [] });
    // 主站的响应头只转 content-type 和 retry-after
    expect(res.headers.get("x-site-internal")).toBeNull();
    expect(res.headers.get("retry-after")).toBe("3");
  });

  it("联网工具：会话令牌放在 Authorization 里也认；查询参数原样转", async () => {
    const before = site.requests.length;
    const search = await fetch(`${proxyUrl}/v1/tools/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    expect(search.status).toBe(200);
    expect(site.requests[before]?.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);

    const list = await fetch(`${proxyUrl}/v1/files?after_id=file_1&limit=2`, {
      headers: { "x-api-key": SESSION_TOKEN },
    });
    expect(list.status).toBe(200);
    expect(site.requests.at(-1)?.url).toBe("/api/gateway/v1/files?after_id=file_1&limit=2");
  });

  it.each([
    ["OpenAI 系（Authorization: Bearer）", { authorization: `Bearer ${SESSION_TOKEN}` }, ""],
    ["Anthropic（x-api-key）", { "x-api-key": SESSION_TOKEN }, ""],
    ["Gemini（x-goog-api-key）", { "x-goog-api-key": SESSION_TOKEN }, ""],
    ["Gemini（查询参数 key）", {}, `&key=${SESSION_TOKEN}`],
  ])(
    "别的提供方（#188）：%s 都认；转给主站的透明转发，令牌不往主站带",
    async (_name, headers: Record<string, string>, extra) => {
      const before = site.requests.length;
      const res = await fetch(
        `${proxyUrl}/v1/providers/my-gateway/models/m:streamGenerateContent?alt=sse${extra}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ contents: [] }),
        },
      );
      expect(res.status).toBe(200);
      const got = site.requests[before];
      expect(got?.url).toBe(
        "/api/gateway/providers/my-gateway/models/m:streamGenerateContent?alt=sse",
      );
      expect(got?.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
      expect(got?.headers["x-seekcloud-session"]).toBe("s1");
      const sent = JSON.stringify(got?.headers);
      expect(sent).not.toContain(SESSION_TOKEN);
      expect(got?.url).not.toContain(SESSION_TOKEN);
    },
  );

  it("会话令牌不对、会话已经结束：拒绝，不转给主站", async () => {
    const before = site.requests.length;
    const wrong = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "nope" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "会话令牌不对，或者会话已经结束" },
    });
    sessions.remove("s1");
    const ended = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": SESSION_TOKEN },
      body: "{}",
    });
    expect(ended.status).toBe(401);
    expect(site.requests.length).toBe(before);
  });

  it("还没连上主站（没有宿主机凭据）：回 503", async () => {
    credential = undefined;
    const res = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": SESSION_TOKEN },
      body: "{}",
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "连不上主站",
    );
  });

  it("路径跑不出 /api/gateway：带 ..、编码过的点和斜杠的一律不收", async () => {
    const before = site.requests.length;
    const auth = { "x-api-key": SESSION_TOKEN };
    for (const path of [
      "/v1/../../hosts/connect",
      "/v1/%2e%2e/%2e%2e/auth/login",
      "/v1/files%2f..%2f..%2fsessions",
      "/v1/files\\..\\..\\x",
    ]) {
      // 规整以后不在 /v1/ 下的不归模型网关管（404），还在 /v1/ 下的直接拒绝（400）
      expect([400, 404], path).toContain((await raw(path, auth)).status);
    }
    expect(site.requests.length).toBe(before);
  });

  it("沙箱那头断开：到主站的请求跟着断", async () => {
    const before = site.requests.length;
    const abort = new AbortController();
    const res = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": SESSION_TOKEN, "content-type": "application/json" },
      body: "{}",
      signal: abort.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    abort.abort();
    await expect.poll(() => site.requests[before]?.closedEarly).toBe(true);
  });

  it("主站连不上：回 502，不带主站的地址", async () => {
    const dead = createGitProxy({
      sessions,
      ca: new ProxyCa(mkdtempSync(join(tmpdir(), "proxy-ca-"))),
      signingKey: loadSigningKey(
        generateKeyPairSync("ed25519")
          .privateKey.export({ format: "pem", type: "pkcs8" })
          .toString(),
        "seekcloud",
      ),
      signerEmail: "bot@seekcloud.test",
      modelGateway: { siteUrl: "http://127.0.0.1:1", credential: () => CREDENTIAL },
    });
    await new Promise<void>((done) => dead.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": SESSION_TOKEN },
        body: "{}",
      });
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain("127.0.0.1:1");
    } finally {
      await new Promise<void>((done) => dead.close(() => done()));
    }
  });
});
