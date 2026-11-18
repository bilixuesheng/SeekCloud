import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

/**
 * 主站替沙箱、替远程服务去连的地址不能是内网（#26 的抓取、#52 的自接 MCP、#133 的插件索引，规则和 #47 的出站代理一样）：
 * 私有网段、回环、链路本地（云厂商的元数据地址 169.254.169.254 在这里）、CGNAT、组播、保留和文档用的网段，
 * 以及 IPv6 的对应网段。IPv6 里嵌着 IPv4 的（::ffff:a.b.c.d、NAT64 的 64:ff9b::/96）按里面的 IPv4 判断。
 *
 * 判断的是解析后的 IP，并且连的就是判断时解析出来的那个地址（publicLookup），防止域名先解析到公网、再解析到内网。
 */

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // 本网络
  ["10.0.0.0", 8], // 私有
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // 回环
  ["169.254.0.0", 16], // 链路本地、云厂商的元数据地址
  ["172.16.0.0", 12], // 私有
  ["192.0.0.0", 24], // IETF 协议分配
  ["192.0.2.0", 24], // 文档用
  ["192.88.99.0", 24], // 6to4 中继
  ["192.168.0.0", 16], // 私有
  ["198.18.0.0", 15], // 基准测试
  ["198.51.100.0", 24], // 文档用
  ["203.0.113.0", 24], // 文档用
  ["224.0.0.0", 4], // 组播
  ["240.0.0.0", 4], // 保留，含 255.255.255.255
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4");
}

const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96], // 未指定、回环、IPv4 兼容（里面的 IPv4 另外判断）
  ["100::", 64], // 丢弃
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // 文档用
  ["2002::", 16], // 6to4
  ["fc00::", 7], // 唯一本地
  ["fe80::", 10], // 链路本地
  ["fec0::", 10], // 站点本地（已废弃）
  ["ff00::", 8], // 组播
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6");
}

/** IPv6 地址展开成 8 个 16 位的数；不是合法的 IPv6 时返回 undefined。 */
export function ipv6Words(address: string): number[] | undefined {
  let text = (address.split("%")[0] ?? "").toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // 末尾是点分的 IPv4（::ffff:1.2.3.4）：换成两个十六进制的数
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return undefined;
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) =>
    part === ""
      ? []
      : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  const left = parse(halves[0] ?? "");
  const right = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return undefined;
  const words = [...left, ...new Array<number>(fill).fill(0), ...right];
  if (words.length !== 8 || words.some((w) => Number.isNaN(w))) return undefined;
  return words;
}

/** IPv6 里嵌着的 IPv4：IPv4 映射（::ffff:a.b.c.d）、IPv4 兼容（::a.b.c.d）、NAT64（64:ff9b::a.b.c.d）。 */
function embeddedIpv4(words: number[]): string | undefined {
  const hi = words[6] as number;
  const lo = words[7] as number;
  const v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (from: number, to: number) => words.slice(from, to).every((w) => w === 0);
  if (zeros(0, 5) && (words[5] === 0xffff || words[5] === 0)) return v4;
  if (words[0] === 0x64 && words[1] === 0xff9b && zeros(2, 6)) return v4;
  return undefined;
}

/** 这个 IP 能不能连：公网地址才能。不是合法的 IP 时也不能。 */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(bare.split("%")[0] ?? "");
  if (family === 4) return !blockedV4.check(bare, "ipv4");
  if (family !== 6) return false;
  const words = ipv6Words(bare);
  if (!words) return false;
  const v4 = embeddedIpv4(words);
  if (v4 !== undefined) return !blockedV4.check(v4, "ipv4");
  return !blockedV6.check(bare.split("%")[0] as string, "ipv6");
}

/** 连到内网、本机这类地址时报的错。 */
export class PrivateAddressError extends Error {
  readonly code = "EPRIVATEADDRESS";
  constructor(readonly host: string) {
    super(`${host} 解析到了内网、本机或元数据这类地址`);
  }
}

/** 主站去连外面时怎么解析域名、哪些地址能连。测试里换成本地的假网站。 */
export interface OutboundNetwork {
  resolve(hostname: string): Promise<LookupAddress[]>;
  allowAddress(address: string): boolean;
}

export const publicNetwork: OutboundNetwork = {
  resolve: (hostname) =>
    new Promise((resolve, reject) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
        error ? reject(error) : resolve(addresses),
      );
    }),
  allowAddress: isPublicAddress,
};

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * 给 http.request 的 lookup：解析出来的地址里只要有一个不能连就整个拒绝（不挑一个能连的去连，
 * 免得轮流解析的域名一会儿给公网、一会儿给内网），能连就把这次解析的结果交给它去连。
 */
export function guardedLookup(network: OutboundNetwork) {
  return (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: LookupCallback,
  ): void => {
    const all = typeof options === "object" && options?.all === true;
    network.resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          const error: NodeJS.ErrnoException = new Error(`找不到 ${hostname}`);
          error.code = "ENOTFOUND";
          callback(error, all ? [] : "", 4);
          return;
        }
        if (addresses.some((a) => !network.allowAddress(a.address))) {
          callback(new PrivateAddressError(hostname), all ? [] : "", 4);
          return;
        }
        if (all) callback(null, addresses);
        else
          callback(
            null,
            (addresses[0] as LookupAddress).address,
            (addresses[0] as LookupAddress).family,
          );
      },
      (error: NodeJS.ErrnoException) => callback(error, all ? [] : "", 4),
    );
  };
}
