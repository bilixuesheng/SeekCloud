import type { Context } from "hono";

/**
 * 这个请求是不是经 HTTPS 来的：请求地址是 https，或者反向代理在 X-Forwarded-Proto 里写的（最后一个值）是 https。
 * Caddy 会覆盖这个头；客户端自己伪造它只会让自己的 Cookie 多带一个 Secure，没有好处。
 */
export function cameOverHttps(c: Context): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  const proto = c.req.header("x-forwarded-proto")?.split(",").at(-1)?.trim().toLowerCase();
  return proto === "https";
}

/**
 * 设 Cookie 时要不要带 Secure（只走 HTTPS）：主站对外的地址是 HTTPS 时总是带（deps.secureCookies），
 * 不然看这个请求是不是经 HTTPS 来的。安装好以后第一次打开的是 http://服务器地址（还没配域名和证书，#96），
 * 这时带了 Secure 的 Cookie 浏览器不存，管理员就登不进去（#94）。
 */
export function secureCookie(c: Context, deps: { secureCookies: boolean }): boolean {
  return deps.secureCookies || cameOverHttps(c);
}
