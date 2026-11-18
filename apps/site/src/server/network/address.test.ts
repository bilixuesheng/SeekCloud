import { describe, expect, it } from "vitest";
import { guardedLookup, ipv6Words, isPublicAddress, PrivateAddressError } from "./address";

describe("哪些地址能连", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "100.63.255.255", // CGNAT 的前一个
    "100.128.0.1", // CGNAT 的后一个
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "[2606:4700:4700::1111]",
  ])("公网地址能连：%s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // 云厂商的元数据地址
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "192.0.2.1",
    "::1",
    "::",
    "[::1]",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // 同上，URL 解析以后是这个写法
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe", // NAT64 里嵌着元数据地址
    "64:ff9b::10.0.0.1",
    "::127.0.0.1",
    "not-an-ip",
    "",
  ])("内网、本机、元数据这类地址不能连：%s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it("网址里各种写法的 IP，URL 解析以后都规整成点分的样子，照样拦得住", () => {
    for (const url of [
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://[0:0:0:0:0:ffff:7f00:1]/",
    ]) {
      const host = new URL(url).hostname;
      expect(isPublicAddress(host), `${url} → ${host}`).toBe(false);
    }
  });

  it("IPv6 展开成 8 个数；不合法的返回空", () => {
    expect(ipv6Words("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Words("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ipv6Words("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Words("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    for (const bad of ["1:::2", "1:2:3:4:5:6:7:8:9", "g::1", "1::2::3", "::ffff:1.2.3"]) {
      expect(ipv6Words(bad), bad).toBeUndefined();
    }
  });
});

describe("解析域名时就拦下", () => {
  const network = (addresses: string[]) => ({
    resolve: async () =>
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    allowAddress: isPublicAddress,
  });
  const lookup = (addresses: string[], all: boolean) =>
    new Promise<{ error: unknown; result: unknown }>((resolve) => {
      guardedLookup(network(addresses))("example.test", { all }, (error, result) =>
        resolve({ error, result }),
      );
    });

  it("都是公网地址：交给它去连（all 时给全部）", async () => {
    expect((await lookup(["93.184.216.34"], false)).result).toBe("93.184.216.34");
    expect((await lookup(["93.184.216.34", "2606:4700::1"], true)).result).toHaveLength(2);
  });

  it("里面有一个是内网地址就整个拒绝，不挑能连的那个", async () => {
    const { error } = await lookup(["93.184.216.34", "10.0.0.1"], true);
    expect(error).toBeInstanceOf(PrivateAddressError);
    expect((await lookup(["127.0.0.1"], false)).error).toBeInstanceOf(PrivateAddressError);
  });

  it("解析不出地址：当作找不到", async () => {
    const { error } = await lookup([], false);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});
