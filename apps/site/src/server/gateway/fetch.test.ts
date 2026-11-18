import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gatewayRequest, startSession } from "../../testing/gateway-client";
import { createTestApp, type TestApp } from "../../testing/test-app";
import { environments, webToolUsage } from "../db/schema";
import { isPublicAddress } from "../network/address";
import type { NetworkAccess } from "../network/policy";

/**
 * 假的"外网"网站开在 127.0.0.2 上（Linux 的回环整段都通）。测试里只把 127.0.0.2 当作能连的公网地址，
 * 127.0.0.1、10.x、169.254.169.254 照样按真的规则拦。域名按下面的表解析，不查真的 DNS。
 */
const SITE_IP = "127.0.0.2";
const DNS: Record<string, string[]> = {
  "site.test": [SITE_IP],
  "raw.githubusercontent.com": [SITE_IP],
  "loop.test": ["127.0.0.1"],
  "internal.test": ["10.0.0.5"],
  "mixed.test": [SITE_IP, "192.168.1.10"],
};

describe("模型网关的网页抓取", () => {
  const seen: { path: string; headers: http.IncomingHttpHeaders }[] = [];
  const site = http.createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    const html = (body: string, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    switch (req.url) {
      case "/page":
        return html(
          `<html><body><h1>标题</h1><p>正文 <a href="/docs">文档</a></p><script>secret()</script></body></html>`,
        );
      case "/plain":
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("纯文本 <b>原样</b>");
      case "/gbk":
        res.writeHead(200, { "content-type": "text/plain; charset=gbk" });
        return res.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
      case "/redirect":
        res.writeHead(302, { location: "/page" });
        return res.end();
      case "/redirect-internal":
        res.writeHead(301, { location: "http://169.254.169.254/latest/meta-data/" });
        return res.end();
      case "/image":
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
      case "/gzip":
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        return res.end(gzipSync("<p>压缩过的</p>"));
      case "/bomb":
        // 解压以后 50 MB 的零：只读 5 MB
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        return res.end(gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x61)));
      case "/missing":
        return html("<p>找不到这一页</p>", 404);
      case "/hang":
        return; // 一直不回
      default:
        return html("<p>?</p>", 404);
    }
  });
  let t: TestApp;
  let sessionId: string;
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((done) => site.listen(0, SITE_IP, done));
    port = (site.address() as AddressInfo).port;
    t = await createTestApp({
      outboundNetwork: {
        resolve: async (host) =>
          (DNS[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
        allowAddress: (ip) => ip === SITE_IP || isPublicAddress(ip),
      },
      webFetchTimeoutMs: 500,
    });
    const { browser } = await t.adminWithGitHub("octo", "octo/app");
    ({ sessionId } = await startSession(t, browser, "octo/app"));
  });
  beforeEach(() => setAccess("full"));
  afterAll(async () => {
    await t.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
  });

  const setAccess = (access: NetworkAccess) =>
    t.db.update(environments).set({ networkAccess: access });
  const fetchUrl = (url: unknown) =>
    gatewayRequest(t, sessionId, "/v1/tools/fetch", { body: { url } });
  const content = async (url: string) => {
    const res = await fetchUrl(url);
    expect(res.status, url).toBe(200);
    return ((await res.json()) as { content: string }).content;
  };

  it("网页转成 Markdown（链接换成绝对地址，脚本不要）；请求里不带会话和凭据；记一次用量", async () => {
    const before = seen.length;
    const text = await content(`http://site.test:${port}/page`);
    expect(text).toContain("# 标题");
    expect(text).toContain(`[文档](http://site.test:${port}/docs)`);
    expect(text).not.toContain("secret");
    const request = seen[before];
    expect(request?.headers["user-agent"]).toContain("SeekCloud");
    for (const name of ["authorization", "cookie", "x-seekcloud-session", "x-api-key"]) {
      expect(request?.headers[name], name).toBeUndefined();
    }
    const rows = await t.db
      .select()
      .from(webToolUsage)
      .where(eq(webToolUsage.sessionId, sessionId));
    expect(rows.at(-1)).toMatchObject({ tool: "web_fetch", provider: null, ok: true });
  });

  it("文本原样给；按字符集解码；gzip 解开", async () => {
    expect(await content(`http://site.test:${port}/plain`)).toBe("纯文本 <b>原样</b>");
    expect(await content(`http://site.test:${port}/gbk`)).toBe("中文");
    expect(await content(`http://site.test:${port}/gzip`)).toBe("压缩过的");
  });

  it("不受环境的网络策略约束（照 Claude Code）：哪一档都能抓，内网照样不连", async () => {
    for (const access of ["none", "default", "custom"] as const) {
      await setAccess(access);
      expect(await content(`http://site.test:${port}/page`), access).toContain("# 标题");
      expect((await fetchUrl("http://169.254.169.254/")).status, access).toBe(403);
    }
  });

  it("不连内网、本机和元数据地址：直接写的 IP、解析出来的、IPv6 里嵌着的，都不发出请求", async () => {
    const before = seen.length;
    for (const url of [
      `http://127.0.0.1:${port}/page`,
      `http://[::ffff:127.0.0.1]:${port}/page`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      `http://loop.test:${port}/page`,
      "http://internal.test/",
      `http://mixed.test:${port}/page`,
    ]) {
      const res = await fetchUrl(url);
      expect(res.status, url).toBe(403);
      expect((await res.json()).error.message, url).toContain("内网");
    }
    expect(seen.length).toBe(before);
  });

  it("不跟着重定向：告诉 Agent 重定向到了哪里，那个地址不去取", async () => {
    const before = seen.length;
    expect(await content(`http://site.test:${port}/redirect`)).toContain(
      `重定向到了 http://site.test:${port}/page`,
    );
    expect(await content(`http://site.test:${port}/redirect-internal`)).toContain(
      "169.254.169.254",
    );
    expect(seen.slice(before).map((r) => r.path)).toEqual(["/redirect", "/redirect-internal"]);
  });

  it("出错的页面照样给内容，前面注明状态码", async () => {
    expect(await content(`http://site.test:${port}/missing`)).toBe(
      "（目标网站返回了状态码 404）\n\n找不到这一页",
    );
  });

  it("不是文本的不收；解压以后太大的只读前面一段", async () => {
    expect((await fetchUrl(`http://site.test:${port}/image`)).status).toBe(415);
    const bomb = await content(`http://site.test:${port}/bomb`);
    expect(bomb.length).toBeLessThan(200_000);
    expect(bomb).toContain("内容太长，后面的已经截掉");
  });

  it("目标网站一直不回：超时", async () => {
    const res = await fetchUrl(`http://site.test:${port}/hang`);
    expect(res.status).toBe(504);
    expect((await res.json()).error.message).toContain("超时");
  });

  it("网址不对：空的、不是 http(s) 的、带用户名密码的、找不到域名的", async () => {
    for (const url of [
      "",
      42,
      "not a url",
      "ftp://site.test/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      `http://user:pass@site.test:${port}/page`,
    ]) {
      expect((await fetchUrl(url)).status, String(url)).toBe(400);
    }
    expect((await fetchUrl("http://nowhere.test/")).status).toBe(502);
  });
});
