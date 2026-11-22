import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { TestApp } from "./test-app";

/** 构建好的网页（pnpm build 打出来的）。 */
export const CLIENT_DIR = join(import.meta.dirname, "../../dist/client");

/**
 * 在本机起一个能用浏览器打开的主站：接口转给 createTestApp() 的主站（假 GitHub、假宿主机），
 * 别的地址给构建好的网页。浏览器测试（*.browser.test.ts）和截图用。要先 pnpm build。
 */
export async function startPreview(
  t: TestApp,
): Promise<{ url: string; close: () => Promise<void> }> {
  if (!existsSync(join(CLIENT_DIR, "index.html"))) {
    throw new Error(`没有构建好的网页（${CLIENT_DIR}），先在 apps/site 里运行 pnpm build`);
  }
  const web = new Hono();
  web.all("/api/*", async (c) => {
    const url = new URL(c.req.url);
    const body = ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.arrayBuffer();
    return t.request(url.pathname + url.search, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body,
      signal: c.req.raw.signal,
    });
  });
  web.use("/*", serveStatic({ root: CLIENT_DIR }));
  web.get("*", serveStatic({ path: join(CLIENT_DIR, "index.html") }));
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: web.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 事件流这类长连接不会自己断：关掉
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
