import { createMiddleware } from "hono/factory";
import { apiError } from "../errors";
import type { HostHub } from "./hub";

export interface HostVariables {
  /** 发请求的宿主机（hostAuth 校验过的）。 */
  host: { id: string; name: string };
}

/**
 * 宿主机凭据的校验：宿主机替沙箱转发到主站的请求（模型网关、平台工具、自接 MCP）带上连接时下发的凭据，
 * 放在 Authorization: Bearer 里。没带、过期、宿主机被吊销都回 401，不区分。之后的工单把它挂在自己的路由上，
 * 路由里用 c.get("host") 拿到是哪台宿主机。
 */
export function hostAuth(hub: Pick<HostHub, "verifyCredential">) {
  return createMiddleware<{ Variables: HostVariables }>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const host = token ? hub.verifyCredential(token) : undefined;
    if (!host) return c.json(apiError("host_unauthorized", "宿主机凭据无效或已过期"), 401);
    c.set("host", host);
    await next();
  });
}
