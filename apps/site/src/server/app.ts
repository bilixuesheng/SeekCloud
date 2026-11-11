import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import type { Database } from "./db/client";
import { apiError, handleError } from "./errors";
import type { GitHub } from "./github/port";
import type { Clock } from "./ports";
import { RateLimiter } from "./rate-limit";
import { accountRoutes } from "./routes/account";
import { authRoutes } from "./routes/auth";
import { githubAuthRoutes, githubRoutes } from "./routes/github";
import { meRoutes } from "./routes/me";
import { newRouter } from "./routes/router";
import { sessionRoutes } from "./routes/sessions";
import type { SecretBox } from "./secrets";
import type { HostLink } from "./sessions/host";
import { Sessions } from "./sessions/sessions";

export interface AppDeps {
  version: string;
  db: Database;
  clock: Clock;
  /** 生产环境里登录 Cookie 只走 HTTPS。 */
  secureCookies: boolean;
  github: GitHub;
  /** 加密存放令牌等敏感内容。 */
  secrets: SecretBox;
  /** 沙箱宿主机。还没有接上时，新会话留在排队中。 */
  host?: HostLink;
  /** 主站自己的数据目录：导出数据的压缩包放在这里的 exports 下面。 */
  dataDir: string;
}

const CheckResult = z.enum(["ok", "error"]);

const Health = z.object({
  status: CheckResult,
  version: z.string(),
  database: CheckResult,
  time: z.string().openapi({ format: "date-time" }),
});

const healthRoute = createRoute({
  method: "get",
  path: "/api/health",
  summary: "健康检查",
  responses: {
    200: { description: "服务正常", content: { "application/json": { schema: Health } } },
    503: { description: "数据库不可用", content: { "application/json": { schema: Health } } },
  },
});

/** 接口的请求体最多这么大。消息最长 10 万字，按每个字 4 字节算也够。 */
const MAX_BODY_BYTES = 1024 * 1024;
/** GitHub 的 webhook 最大 25 MB，再大的它自己就不发了。 */
const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

const tooLarge = (c: Context) => c.json(apiError("body_too_large", "请求内容过大"), 413);
const apiBodyLimit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge });
const webhookBodyLimit = bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: tooLarge });

export function createApp(deps: AppDeps) {
  const app = newRouter();

  // 浏览器这边的几道保险，接口和页面（main.ts 里挂的静态文件）都带上。
  // - 内容安全策略：脚本只能来自本站，页面里不能有内联脚本。Agent 的输出是按白名单渲染的，
  //   这是万一漏了一处时的第二道保险。图片可以来自任何地址（Agent 回复里的图片）。
  // - 不允许别的网站把主站嵌进框架里（点击劫持）。
  // - 不发 HSTS：要不要强制 HTTPS 由前面的反向代理定，主站自己不知道是不是一直有 HTTPS。
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      xFrameOptions: "DENY",
      referrerPolicy: "same-origin",
      strictTransportSecurity: false,
    }),
  );

  // 请求体有上限：登录、webhook 这些不用登录就能调的接口，不能让人发一个几 GB 的请求把内存占满。
  app.use("/api/*", (c, next) =>
    c.req.path === "/api/github/webhook" ? webhookBodyLimit(c, next) : apiBodyLimit(c, next),
  );

  // 登录状态放在 Cookie 里，所以拒绝别的网站发来的表单请求。接口只收 JSON，跨站的 JSON 请求浏览器本来就拦。
  app.use("/api/*", csrf());

  app.openapi(healthRoute, async (c) => {
    const database = await deps.db.execute(sql`select 1`).then(
      () => "ok" as const,
      () => "error" as const,
    );
    const body = {
      status: database,
      version: deps.version,
      database,
      time: deps.clock.now().toISOString(),
    };
    return database === "ok" ? c.json(body, 200) : c.json(body, 503);
  });

  const limiter = new RateLimiter(deps.clock);
  app.route("/api/auth/github", githubAuthRoutes(deps));
  const sessions = new Sessions(deps);
  app.route("/api/account", accountRoutes(deps));
  app.route("/api/auth", authRoutes(deps, limiter));
  app.route("/api/github", githubRoutes(deps, sessions));
  app.route("/api", sessionRoutes(deps, sessions));
  app.route("/api", meRoutes(deps));

  app.onError(handleError);
  app.notFound((c) => c.json(apiError("not_found", "接口不存在"), 404));

  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "SeekCloud", version: deps.version },
  });

  return app;
}
