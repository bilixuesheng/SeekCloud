import { PROTOCOL_VERSION } from "@seekcloud/protocol";
import { startGitProxy } from "./git-proxy/start";

// 宿主机守护进程。连主站、管理沙箱以后再做；这里先把 Git 代理跑起来。
console.log(`SeekCloud 宿主机守护进程（协议版本 ${PROTOCOL_VERSION}）`);

const signingKeyPath = process.env.SEEKCLOUD_SIGNING_KEY;
const signerEmail = process.env.SEEKCLOUD_SIGNER_EMAIL;
if (signingKeyPath && signerEmail) {
  const port = Number(process.env.SEEKCLOUD_GIT_PROXY_PORT ?? 3128);
  const host = process.env.SEEKCLOUD_GIT_PROXY_HOST ?? "127.0.0.1";
  startGitProxy({
    dataDir: process.env.SEEKCLOUD_HOST_DATA ?? "/var/lib/seekcloud",
    signingKeyPath,
    signerEmail,
    host,
    port,
  });
  console.log(`Git 代理已启动：http://${host}:${port}`);
}
