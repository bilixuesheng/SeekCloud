import { PROTOCOL_VERSION } from "@seekcloud/protocol";
import { SandboxAgents } from "./agent/sandbox-agents";
import { GitSessions } from "./git-proxy/sessions";
import { startGitProxy } from "./git-proxy/start";
import type { ModelGatewayLink } from "./model-gateway/forward";
import { applyFirewall, DEFAULT_NETWORK, ensureSandboxNetwork } from "./sandbox/network";
import type { SandboxGit } from "./sandbox/provision";
import { Sandboxes } from "./sandbox/sandboxes";
import { handleCommands } from "./site-link/commands";
import { SiteLink } from "./site-link/connection";
import { hostReport } from "./site-link/report";

// 宿主机守护进程：连上主站接命令（#91），建沙箱（#18），跑 Git 代理。
const version = process.env.SEEKCLOUD_VERSION ?? "dev";
const dataDir = process.env.SEEKCLOUD_HOST_DATA ?? "/var/lib/seekcloud";
console.log(`SeekCloud 宿主机守护进程 ${version}（协议版本 ${PROTOCOL_VERSION}）`);

const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 要是正数`);
  return value;
};

/**
 * 沙箱（ADR 0005）：配了 SEEKCLOUD_SANDBOX_IMAGE 才建。先建沙箱专用的网络、加防火墙规则，
 * 两样有一样不成就不建沙箱（宁可建不了，也不让沙箱连得上宿主机的其他端口）。要 root。
 */
async function setUpSandboxes(gitProxyPort: number) {
  const image = process.env.SEEKCLOUD_SANDBOX_IMAGE;
  if (!image) {
    console.log("没有设置 SEEKCLOUD_SANDBOX_IMAGE，不建沙箱：新会话会以“无法创建沙箱”失败。");
    return undefined;
  }
  try {
    const network = await ensureSandboxNetwork({
      ...DEFAULT_NETWORK,
      subnet: process.env.SEEKCLOUD_SANDBOX_SUBNET || undefined,
    });
    await applyFirewall({
      bridge: network.bridge,
      gateway: network.gateway,
      ports: [gitProxyPort],
    });
    const diskGb = positive("SEEKCLOUD_SANDBOX_DISK_GB", 30);
    if (!Number.isInteger(diskGb)) throw new Error("SEEKCLOUD_SANDBOX_DISK_GB 要是整数");
    const sandboxes = new Sandboxes({
      image,
      runtime: process.env.SEEKCLOUD_SANDBOX_RUNTIME ?? "sysbox-runc",
      network: network.name,
      cpus: positive("SEEKCLOUD_SANDBOX_CPUS", 4),
      memoryMb: positive("SEEKCLOUD_SANDBOX_MEMORY_MB", 4096),
      // 沙箱自己的 /var/lib/docker 和磁盘上限（#168）
      storage: {
        dir: process.env.SEEKCLOUD_SANDBOX_DATA ?? `${dataDir}/sandboxes`,
        limitGb: diskGb,
      },
    });
    const quota = await sandboxes.diskQuota();
    console.log(
      `沙箱：镜像 ${image}，网络 ${network.name}（${network.subnet}），宿主机已有 ${await sandboxes.count()} 个沙箱；` +
        (quota.ok
          ? `每个沙箱的磁盘上限 ${diskGb} GB`
          : `单个沙箱的磁盘上限不生效：${quota.reason}（见 scripts/test-machine.sh 的"沙箱的存储"）`),
    );
    return { sandboxes, gateway: network.gateway };
  } catch (error) {
    console.error(
      `沙箱的网络或防火墙没准备好，不建沙箱：${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

async function main() {
  // Git 代理和主站连接共用一份会话登记表：主站下发的仓库、令牌、AI 标识的开关都记在这里。
  const sessions = new GitSessions();
  const gitProxyPort = Number(process.env.SEEKCLOUD_GIT_PROXY_PORT ?? 3128);
  const sandbox = await setUpSandboxes(gitProxyPort);

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

  // 只监听沙箱网桥上的地址，不监听对外的网卡（#18 评论第 4 条）。
  const gitProxyHost = process.env.SEEKCLOUD_GIT_PROXY_HOST ?? sandbox?.gateway ?? "127.0.0.1";
  const signingKeyPath = process.env.SEEKCLOUD_SIGNING_KEY;
  const signerEmail = process.env.SEEKCLOUD_SIGNER_EMAIL;
  let git: SandboxGit | undefined;
  if (signingKeyPath && signerEmail) {
    const host = gitProxyHost;
    const proxy = startGitProxy(
      { dataDir, signingKeyPath, signerEmail, host, port: gitProxyPort },
      sessions,
      modelGateway,
    );
    // 沙箱里的 git 配置（sandbox/provision.ts）
    git = {
      proxy: { host, port: gitProxyPort },
      caPem: proxy.caPem,
      signingPublicKey: proxy.signingPublicKey,
      fallbackCommitter: { name: "SeekCloud", email: signerEmail },
    };
    console.log(`Git 代理已启动：http://${host}:${gitProxyPort}`);
  } else if (sandbox) {
    console.log(
      "没有设置 SEEKCLOUD_SIGNING_KEY 和 SEEKCLOUD_SIGNER_EMAIL，Git 代理没有启动，沙箱里跑不了 Agent。",
    );
  }

  if (!siteUrl || !key) {
    console.log("没有设置 SEEKCLOUD_SITE_URL 和 SEEKCLOUD_HOST_KEY，不连主站。");
    return;
  }
  // 先建连接，命令处理里要用它回事件。
  const site: SiteLink = new SiteLink({
    siteUrl,
    key,
    version,
    onCommand: (command) => commands(command),
  });
  link = site;
  // 沙箱里的 dsh（#25）：调模型经 Git 代理端口上的模型网关转发
  const agents =
    sandbox && git
      ? new SandboxAgents({
          sandboxes: sandbox.sandboxes,
          sessions,
          git,
          emit: (event) => site.send(event),
        })
      : undefined;
  const commands = handleCommands({
    sessions,
    sandboxes: sandbox?.sandboxes,
    git,
    agents,
    send: (event) => site.send(event),
  });
  site.start();
  // 每 30 秒报一次负载。数沙箱失败（Docker 停了）时照样报，沙箱数记 0。
  setInterval(async () => {
    const count = sandbox ? await sandbox.sandboxes.count().catch(() => 0) : 0;
    const quota = sandbox ? await sandbox.sandboxes.diskQuota().catch(() => undefined) : undefined;
    site.report(hostReport(dataDir, count, quota?.ok ?? false));
  }, 30_000).unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    // 只断开和主站的连接：沙箱不跟着停（#18 的 2026-11-15 评论）。
    process.on(signal, () => void site.stop().then(() => process.exit(0)));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
