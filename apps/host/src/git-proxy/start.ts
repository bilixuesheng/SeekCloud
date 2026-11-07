import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { loadSigningKey } from "../signing/sshsig";
import { ProxyCa } from "./ca";
import { createGitProxy } from "./proxy";
import { GitSessions } from "./sessions";

export interface GitProxyConfig {
  /** 宿主机自己的数据目录：代理的 CA 放在这里。 */
  dataDir: string;
  /** SeekCloud 账号的签名私钥（ed25519，PKCS#8 PEM）。 */
  signingKeyPath: string;
  /** SeekCloud 账号的邮箱，沙箱里 git 的 user.email 也设成它。 */
  signerEmail: string;
  /** 只监听沙箱网桥上的地址，不对外。 */
  host: string;
  port: number;
}

/** 启动 Git 代理，返回会话登记表（宿主机守护进程按主站的命令登记、下发令牌、注销）。 */
export function startGitProxy(config: GitProxyConfig): { sessions: GitSessions; server: Server } {
  const sessions = new GitSessions();
  const server = createGitProxy({
    sessions,
    ca: new ProxyCa(join(config.dataDir, "proxy-ca")),
    signingKey: loadSigningKey(readFileSync(config.signingKeyPath, "utf8"), "seekcloud"),
    signerEmail: config.signerEmail,
  });
  server.listen(config.port, config.host);
  return { sessions, server };
}
