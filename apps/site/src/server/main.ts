import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type AppDeps, createApp } from "./app";
import { connectDatabase } from "./db/client";
import { runMigrations } from "./db/migrate";
import { githubApi, unconfiguredGitHub } from "./github/api";
import { googleApi } from "./google/api";
import { unconfiguredGoogle } from "./google/port";
import { noHumanCheck, turnstile } from "./human-check";
import { resendMailer } from "./mail/resend";
import { startMaintenance } from "./maintenance";
import { systemClock, unconfiguredMailer } from "./ports";
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
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  // 导出数据的压缩包放在这里；部署时放到会备份的磁盘上，不要放进代码目录。
  dataDir: process.env.SEEKCLOUD_DATA_DIR ?? "./data",
  db,
  clock: systemClock,
  mailer: process.env.RESEND_API_KEY
    ? resendMailer({
        apiKey: process.env.RESEND_API_KEY,
        from: process.env.MAIL_FROM ?? "SeekCloud <noreply@seekcloud.test>",
      })
    : unconfiguredMailer,
  seatLimit: Number(process.env.SEEKCLOUD_SEAT_LIMIT ?? 30),
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
  google: process.env.GOOGLE_CLIENT_ID
    ? googleApi({
        clientId: required("GOOGLE_CLIENT_ID"),
        clientSecret: required("GOOGLE_CLIENT_SECRET"),
        callbackUrl: `${required("PUBLIC_URL")}/api/auth/google/callback`,
      })
    : unconfiguredGoogle,
  secureCookies: process.env.NODE_ENV === "production",
  // 两个都配了才打开人机验证；只配一个多半是漏了，直接报错。
  humanCheck:
    process.env.TURNSTILE_SITE_KEY || process.env.TURNSTILE_SECRET_KEY
      ? turnstile({
          siteKey: required("TURNSTILE_SITE_KEY"),
          secretKey: required("TURNSTILE_SECRET_KEY"),
        })
      : noHumanCheck,
};
const app = createApp(deps);
// 打包数据导出、清理过期导出和已删除的账户，每分钟一次。
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
