import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { csrf } from "hono/csrf";
import type { Database } from "./db/client";
import { apiError, handleError } from "./errors";
import type { GitHub } from "./github/port";
import type { Clock, Mailer } from "./ports";
import { RateLimiter } from "./rate-limit";
import { accountRoutes } from "./routes/account";
import { authRoutes } from "./routes/auth";
import { githubAuthRoutes, githubRoutes } from "./routes/github";
import { meRoutes } from "./routes/me";
import { newRouter } from "./routes/router";
import { sessionRoutes } from "./routes/sessions";
import { pendingIdentityRoutes } from "./routes/third-party";
import type { SecretBox } from "./secrets";
import type { HostLink } from "./sessions/host";
import { Sessions } from "./sessions/sessions";

export interface AppDeps {
  version: string;
  db: Database;
  clock: Clock;
  mailer: Mailer;
  /** 内测席位总数：用户数到了就不能再注册。 */
  seatLimit: number;
  /** 生产环境里登录 Cookie 只走 HTTPS。 */
  secureCookies: boolean;
  github: GitHub;
  /** 加密存放令牌等敏感内容。 */
  secrets: SecretBox;
  /** 沙箱宿主机。还没有接上时，新会话留在排队中。 */
  host?: HostLink;
  /** 主站对外的地址（PUBLIC_URL），写进邮件里的链接。 */
  publicUrl: string;
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

export function createApp(deps: AppDeps) {
  const app = newRouter();

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
  app.route("/api/auth/pending", pendingIdentityRoutes(deps, limiter));
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
