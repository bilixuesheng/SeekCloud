import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type AppDeps, createApp } from "./app";
import { adminIdentity } from "./auth/admin-identity";
import { connectDatabase } from "./db/client";
import { runMigrations } from "./db/migrate";
import { configuredRouting, transparentErrors, usageAdmission } from "./gateway/trunk";
import { githubApi, unconfiguredGitHub } from "./github/api";
import { HostHub } from "./hosts/hub";
import { startMaintenance } from "./maintenance";
import { createModelCatalog } from "./models/providers";
import { systemClock } from "./ports";
import { SecretBox } from "./secrets";
import { adminSettingsFrom } from "./settings";

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
// 设置的读写规则：主干的规则，加上安装脚本用环境变量写的初始值（比如前面有几层反向代理）。
const settingsPolicy = adminSettingsFrom(process.env);

const base = {
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
  // 主站对外的地址是 HTTPS 时 Cookie 总是带 Secure；没配时按每个请求是不是经 HTTPS 来的定（装好后先用 http 打开）
  secureCookies: process.env.PUBLIC_URL?.startsWith("https://") ?? false,
  publicUrl: process.env.PUBLIC_URL,
  settingsPolicy,
};
// 提供方和模型：路由和主站共用一个（DeepSeek 发布的模型列表缓存在里面）。
const models = createModelCatalog(base);
// 扩展点（ADR 0010）：主干用单管理员的实现。
const deps: AppDeps = {
  ...base,
  identity: adminIdentity(base),
  modelAdmission: usageAdmission(base),
  providerRouting: configuredRouting(base, models),
  errorPresentation: transparentErrors,
  models,
};
// 沙箱宿主机用宿主机密钥连上来（pnpm host:create 添加）。一台都没连着时，新会话留在排队中。
const hub = new HostHub(deps);
deps.host = hub;
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

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => {
  console.log(`SeekCloud 主站已启动：http://localhost:${info.port}`);
});
hub.attach(server as Server);
await hub.start();
