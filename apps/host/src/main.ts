import { PROTOCOL_VERSION } from "@seekcloud/protocol";
import { GitSessions } from "./git-proxy/sessions";
import { startGitProxy } from "./git-proxy/start";
import type { ModelGatewayLink } from "./model-gateway/forward";
import { handleCommands } from "./site-link/commands";
import { SiteLink } from "./site-link/connection";
import { hostReport } from "./site-link/report";

// 宿主机守护进程：连上主站接命令（#91），跑 Git 代理。沙箱在 #18 里做。
const version = process.env.SEEKCLOUD_VERSION ?? "dev";
const dataDir = process.env.SEEKCLOUD_HOST_DATA ?? "/var/lib/seekcloud";
console.log(`SeekCloud 宿主机守护进程 ${version}（协议版本 ${PROTOCOL_VERSION}）`);

// Git 代理和主站连接共用一份会话登记表：主站下发的仓库、令牌、AI 标识的开关都记在这里。
const sessions = new GitSessions();

const siteUrl = process.env.SEEKCLOUD_SITE_URL;
const key = process.env.SEEKCLOUD_HOST_KEY;
let link: SiteLink | undefined;
// 沙箱调模型、Files、联网工具的请求经 Git 代理的端口转给主站，带上连接时下发的宿主机凭据。
const modelGateway: ModelGatewayLink | undefined = siteUrl
  ? {
      siteUrl,
      credential: () => {
        const credential = link?.credential;
        return credential && Date.parse(credential.expiresAt) > Date.now()
          ? credential.token
          : undefined;
      },
    }
  : undefined;

const signingKeyPath = process.env.SEEKCLOUD_SIGNING_KEY;
const signerEmail = process.env.SEEKCLOUD_SIGNER_EMAIL;
if (signingKeyPath && signerEmail) {
  const port = Number(process.env.SEEKCLOUD_GIT_PROXY_PORT ?? 3128);
  const host = process.env.SEEKCLOUD_GIT_PROXY_HOST ?? "127.0.0.1";
  startGitProxy({ dataDir, signingKeyPath, signerEmail, host, port }, sessions, modelGateway);
  console.log(`Git 代理已启动：http://${host}:${port}`);
}

if (siteUrl && key) {
  // 先建连接，命令处理里要用它回事件。
  const site: SiteLink = new SiteLink({
    siteUrl,
    key,
    version,
    onCommand: (command) => commands(command),
  });
  link = site;
  const commands = handleCommands({ sessions, send: (event) => site.send(event) });
  site.start();
  // 每 30 秒报一次负载。沙箱数在 #18 里接上。
  setInterval(() => site.report(hostReport(dataDir, 0)), 30_000).unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void site.stop().then(() => process.exit(0)));
  }
} else {
  console.log("没有设置 SEEKCLOUD_SITE_URL 和 SEEKCLOUD_HOST_KEY，不连主站。");
}
