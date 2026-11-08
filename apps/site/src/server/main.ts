import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type AppDeps, createApp } from "./app";
import { connectDatabase } from "./db/client";
import { runMigrations } from "./db/migrate";
import { githubApi, unconfiguredGitHub } from "./github/api";
import { startMaintenance } from "./maintenance";
import { systemClock } from "./ports";
import { SecretBox } from "./secrets";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

const databaseUrl = required("DATABASE_URL");
// 32 字节的随机密钥，base64 编码。生成：openssl rand -base64 32
const secrets = new SecretBox(Buffer.from(required("SEEKCLOUD_SECRET_KEY"), "base64"));

const { db } = connectDatabase(databaseUrl);
await runMigrations(db);

const deps: AppDeps = {
  version: process.env.SEEKCLOUD_VERSION ?? "dev",
  // 导出数据的压缩包放在这里；部署时放到会备份的磁盘上，不要放进代码目录。
  dataDir: process.env.SEEKCLOUD_DATA_DIR ?? "./data",
  db,
  clock: systemClock,
  secrets,
  github: process.env.GITHUB_CLIENT_ID
    ? githubApi({
        clientId: required("GITHUB_CLIENT_ID"),
        clientSecret: required("GITHUB_CLIENT_SECRET"),
        appSlug: required("GITHUB_APP_SLUG"),
        webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
        callbackUrl: `${required("PUBLIC_URL")}/api/auth/github/callback`,
      })
    : unconfiguredGitHub,
  secureCookies: process.env.NODE_ENV === "production",
};
const app = createApp(deps);
// 打包数据导出、清理过期的导出和访问记录，每分钟一次。
startMaintenance(deps);

// 前端构建产物。不是 /api 的其他路径都返回 index.html，交给前端路由。
const clientDir = "./dist/client";
app.use("/*", serveStatic({ root: clientDir }));
app.get("*", (c, next) =>
  c.req.path.startsWith("/api/")
    ? next()
    : serveStatic({ path: `${clientDir}/index.html` })(c, next),
);

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => {
  console.log(`SeekCloud 主站已启动：http://localhost:${info.port}`);
});
