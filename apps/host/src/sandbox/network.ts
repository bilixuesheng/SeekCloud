import { Docker, DockerError, isNotFound, type Runner, runProgram } from "./docker";

export interface SandboxNetworkConfig {
  /** Docker 网络的名字。 */
  name: string;
  /** 宿主机上网桥的名字（最多 15 个字符），防火墙规则按它认沙箱来的流量。 */
  bridge: string;
  /** 网段，比如 172.31.250.0/24。不给就让 Docker 从它的地址池里挑。 */
  subnet?: string;
}

export interface SandboxNetwork {
  name: string;
  bridge: string;
  subnet: string;
  /** 网桥在宿主机这边的地址：宿主机给沙箱的服务（Git 代理、签名、各种转发）只监听这个地址。 */
  gateway: string;
}

export const DEFAULT_NETWORK: SandboxNetworkConfig = {
  name: "seekcloud-sandbox",
  bridge: "seekcloud0",
};

const ICC = "com.docker.network.bridge.enable_icc";
const BRIDGE_NAME = "com.docker.network.bridge.name";

interface NetworkInspect {
  Options?: Record<string, string>;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
}

/**
 * 沙箱专用的 Docker 网络（#18 评论第 4 条）：关掉容器之间的互通（ICC），沙箱之间连不通；
 * 网桥用固定的名字，防火墙规则按它认。网络不依赖守护进程，守护进程重启时已经有了就直接用。
 */
export async function ensureSandboxNetwork(
  config: SandboxNetworkConfig,
  docker = new Docker(),
): Promise<SandboxNetwork> {
  let net = await inspectNetwork(docker, config.name);
  if (!net) {
    const args = [
      "network",
      "create",
      "--driver",
      "bridge",
      "--opt",
      `${BRIDGE_NAME}=${config.bridge}`,
      "--opt",
      `${ICC}=false`,
      "--label",
      "cn.seekcloud.sandbox-network=1",
    ];
    if (config.subnet) args.push("--subnet", config.subnet);
    args.push(config.name);
    const result = await docker.raw(args);
    // 两个进程同时建（或者刚被别人建好）：再查一次
    if (result.code !== 0 && !/already exists/i.test(result.stderr)) {
      throw new DockerError(args, result);
    }
    net = await inspectNetwork(docker, config.name);
    if (!net) throw new Error(`网络 ${config.name} 建了以后找不到`);
  }
  const options = net.Options ?? {};
  if (options[ICC] !== "false" || options[BRIDGE_NAME] !== config.bridge) {
    // 管理员手动建过一个同名的网络：不改它，让管理员处理，免得沙箱之间悄悄互通。
    throw new Error(
      `网络 ${config.name} 已经有了，但没有关掉容器之间的互通或者网桥不叫 ${config.bridge}：删掉它（docker network rm ${config.name}）再启动`,
    );
  }
  const ipam = net.IPAM?.Config?.[0];
  if (!ipam?.Subnet || !ipam.Gateway) throw new Error(`网络 ${config.name} 没有 IPv4 网段`);
  return { name: config.name, bridge: config.bridge, subnet: ipam.Subnet, gateway: ipam.Gateway };
}

async function inspectNetwork(docker: Docker, name: string): Promise<NetworkInspect | undefined> {
  const args = ["network", "inspect", "--format", "{{json .}}", name];
  const result = await docker.raw(args);
  if (isNotFound(result)) return undefined;
  if (result.code !== 0) throw new DockerError(args, result);
  return JSON.parse(result.stdout) as NetworkInspect;
}

/** 测试用完把网络删掉。 */
export async function removeSandboxNetwork(name: string, docker = new Docker()): Promise<void> {
  const result = await docker.raw(["network", "rm", name]);
  if (result.code !== 0 && !isNotFound(result)) throw new DockerError(["network", "rm"], result);
}

// ---- 防火墙 ----

export interface FirewallConfig {
  bridge: string;
  gateway: string;
  /** 沙箱能连的宿主机端口（只在网桥地址上）：Git 代理这些。 */
  ports: number[];
  /** iptables 里我们自己的链。测试用别的名字，和正式的互不干扰。 */
  chain?: string;
}

const DEFAULT_CHAIN = "SEEKCLOUD-SANDBOX";

/**
 * 沙箱连宿主机的规矩（#18 评论第 4 条）：从沙箱网桥进到宿主机的流量，只放行网桥地址上给沙箱的那几个端口，
 * 宿主机上别的端口（SSH、Docker 的接口、守护进程自己的管理端口……）一律连不上。沙箱出去上网走的是转发，不受影响。
 *
 * 规则写进内核，不依赖守护进程活着；守护进程每次启动都重写一遍我们自己的链（iptables-restore 一次换完，
 * 中间没有空档），INPUT 里跳到这条链的那一条没有才加。要 root。
 */
export async function applyFirewall(
  config: FirewallConfig,
  run: Runner = runProgram,
): Promise<void> {
  const chain = config.chain ?? DEFAULT_CHAIN;
  for (const family of [4, 6] as const) {
    const lines = [
      "*filter",
      `:${chain} - [0:0]`,
      `-A ${chain} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
      ...(family === 4
        ? config.ports.map(
            (port) => `-A ${chain} -d ${config.gateway}/32 -p tcp -m tcp --dport ${port} -j ACCEPT`,
          )
        : []),
      `-A ${chain} -p tcp -j REJECT --reject-with tcp-reset`,
      `-A ${chain} -j DROP`,
      "COMMIT",
      "",
    ];
    const restore = family === 4 ? "iptables-restore" : "ip6tables-restore";
    const iptables = family === 4 ? "iptables" : "ip6tables";
    await must(run, restore, ["-w", "--noflush"], lines.join("\n"));
    const jump = ["INPUT", "-i", config.bridge, "-j", chain];
    if ((await run(iptables, ["-w", "-C", ...jump])).code !== 0) {
      await must(run, iptables, ["-w", "-I", jump[0] as string, "1", ...jump.slice(1)]);
    }
  }
}

/** 删掉规则（测试用完、卸载时）。 */
export async function removeFirewall(
  config: Pick<FirewallConfig, "bridge" | "chain">,
  run: Runner = runProgram,
): Promise<void> {
  const chain = config.chain ?? DEFAULT_CHAIN;
  for (const iptables of ["iptables", "ip6tables"]) {
    while (
      (await run(iptables, ["-w", "-D", "INPUT", "-i", config.bridge, "-j", chain])).code === 0
    ) {
      // 有几条删几条
    }
    await run(iptables, ["-w", "-F", chain]);
    await run(iptables, ["-w", "-X", chain]);
  }
}

async function must(run: Runner, file: string, args: string[], input?: string): Promise<void> {
  const result = await run(file, args, { input, timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new Error(
      `${file} ${args.join(" ")} 失败：${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

/**
 * 不是 root 时（测试机上的 Runner 是普通用户，但在 docker 组里）借一个特权容器在宿主机上跑命令。
 * 只给测试用：docker 组本来就等于 root，这里没有多给权限。
 */
export function rootViaDocker(image: string, docker = new Docker()): Runner {
  return (file, args, options) =>
    docker.raw(
      [
        "run",
        "--rm",
        "--interactive",
        "--privileged",
        "--network",
        "host",
        "--pid",
        "host",
        "--volume",
        "/:/host",
        image,
        "chroot",
        "/host",
        file,
        ...args,
      ],
      options,
    );
}
