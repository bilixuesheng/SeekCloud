import { randomBytes, randomUUID } from "node:crypto";
import { connect, createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Docker, runProgram } from "./docker";
import {
  applyFirewall,
  ensureSandboxNetwork,
  removeFirewall,
  removeSandboxNetwork,
  rootViaDocker,
  type SandboxNetwork,
} from "./network";
import { Sandboxes, type SandboxSpec } from "./sandboxes";

/**
 * 测试缝 ②（沙箱部分）：用真的 Docker 建沙箱。设 SEEKCLOUD_DOCKER_TESTS=1 才跑：
 *
 * - 本机：有 Docker、是 root 就行，运行时默认 runc（SEEKCLOUD_SANDBOX_RUNTIME 可以改）；
 * - 测试机（.github/workflows/sandbox.yml）：运行时 sysbox-runc；Runner 不是 root，防火墙借特权容器加
 *   （SEEKCLOUD_TEST_ROOT=docker）。
 *
 * Sysbox 才有的（沙箱里跑 Docker、用户映射）在 sandbox.sysbox.test.ts。
 */
const enabled = process.env.SEEKCLOUD_DOCKER_TESTS === "1";
const runtime = process.env.SEEKCLOUD_SANDBOX_RUNTIME ?? "runc";
const IMAGE = "alpine:3.22";

describe.skipIf(!enabled)("沙箱（真的 Docker）", { timeout: 120_000 }, () => {
  const docker = new Docker();
  const root =
    process.env.SEEKCLOUD_TEST_ROOT === "docker" ? rootViaDocker(IMAGE, docker) : runProgram;
  const pool = `t${randomBytes(3).toString("hex")}`;
  const chain = `SC-TEST-${pool}`;
  const spec: SandboxSpec = {
    image: IMAGE,
    runtime,
    network: `seekcloud-test-${pool}`,
    cpus: 1.5,
    memoryMb: 256,
    command: ["sleep", "infinity"],
    pool,
  };
  let net: SandboxNetwork;
  let sandboxes: Sandboxes;
  const servers: Server[] = [];

  beforeAll(async () => {
    await docker.ensureImage(IMAGE);
    net = await ensureSandboxNetwork({ name: spec.network, bridge: `sc${pool}` }, docker);
    sandboxes = new Sandboxes(spec, docker);
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    if (!sandboxes) return;
    for (const s of await sandboxes.list()) await sandboxes.remove(s.sessionId);
    await removeFirewall({ bridge: net.bridge, chain }, root);
    await removeSandboxNetwork(spec.network, docker);
  });

  const sh = async (sessionId: string, script: string, ...args: string[]) => {
    const r = await sandboxes.exec(sessionId, ["sh", "-c", script, "sh", ...args]);
    return { ...r, out: r.stdout.trim() };
  };

  it("建、停、再启动文件还在，删掉文件就没了；守护进程重启以后按会话认回来，不重复建", async () => {
    const id = randomUUID();
    expect(await sandboxes.find(id)).toBeUndefined();
    const first = await sandboxes.ensure(id);
    expect(first.state).toBe("running");
    await sh(id, "echo 留着 > /root/note");

    await sandboxes.stop(id);
    expect((await sandboxes.find(id))?.state).toBe("stopped");
    // 守护进程重启：新的实例，什么都没记着
    const restarted = new Sandboxes(spec, docker);
    expect(await restarted.list()).toContainEqual({ ...first, state: "stopped" });
    const again = await restarted.ensure(id);
    expect(again.containerId).toBe(first.containerId);
    expect((await sh(id, "cat /root/note")).out).toBe("留着");

    await restarted.remove(id);
    expect(await sandboxes.find(id)).toBeUndefined();
    const fresh = await sandboxes.ensure(id);
    expect(fresh.containerId).not.toBe(first.containerId);
    expect((await sh(id, "cat /root/note 2>&1")).exitCode).not.toBe(0);
    await sandboxes.remove(id);
    // 不在的沙箱：停、删都什么也不做
    await sandboxes.stop(id);
    await sandboxes.remove(id);
  });

  it("同一个会话同时准备两次只建一个", async () => {
    const id = randomUUID();
    const [a, b] = await Promise.all([sandboxes.ensure(id), sandboxes.ensure(id)]);
    expect(a.containerId).toBe(b.containerId);
    expect((await sandboxes.list()).filter((s) => s.sessionId === id)).toHaveLength(1);
    await sandboxes.remove(id);
  });

  it("CPU 和内存有上限，不给交换分区；用的是指定的运行时", async () => {
    const id = randomUUID();
    await sandboxes.ensure(id);
    const host = JSON.parse(
      await docker.ok([
        "container",
        "inspect",
        "--format",
        "{{json .HostConfig}}",
        sandboxes.containerName(id),
      ]),
    );
    expect(host).toMatchObject({
      Runtime: runtime,
      NanoCpus: 1.5e9,
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
    });
    await sandboxes.remove(id);
  });

  it("命令的参数原样传进去：$(...)、--upload-pack=...、空格、引号、换行都不被解释", async () => {
    const id = randomUUID();
    await sandboxes.ensure(id);
    const tricky = [
      "--upload-pack=touch /tmp/pwned",
      "$(touch /tmp/pwned)",
      "`touch /tmp/pwned`",
      "带 空格 的",
      `"双引号" 和 '单引号'`,
      "a;b|c&&d",
      "-n",
    ];
    const r = await sandboxes.exec(id, ["printf", "%s\\n", ...tricky]);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(r.stdout).toBe(`${tricky.join("\n")}\n`);
    expect((await sh(id, "test -e /tmp/pwned")).exitCode).toBe(1);
    // 环境变量的值也一样
    const env = await sandboxes.exec(id, ["sh", "-c", 'printf %s "$V"'], {
      env: { V: "$(id) `id`" },
    });
    expect(env.stdout).toBe("$(id) `id`");
    expect(() => sandboxes.containerName("../etc")).toThrow();
    await expect(sandboxes.exec(id, ["true"], { env: { "A=B": "x" } })).rejects.toThrow();
    await sandboxes.remove(id);
  });

  it("标准输入、退出码、标准错误、工作目录、用户", async () => {
    const id = randomUUID();
    await sandboxes.ensure(id);
    expect((await sandboxes.exec(id, ["cat"], { input: "从标准输入\n" })).stdout).toBe(
      "从标准输入\n",
    );
    expect(await sh(id, "echo 出错了 >&2; exit 3")).toMatchObject({
      exitCode: 3,
      stderr: "出错了\n",
    });
    expect((await sandboxes.exec(id, ["pwd"], { cwd: "/tmp" })).stdout.trim()).toBe("/tmp");
    expect((await sandboxes.exec(id, ["id", "-u"], { user: "nobody" })).stdout.trim()).not.toBe(
      "0",
    );
    // 没开着的沙箱不能跑命令
    await sandboxes.stop(id);
    await expect(sandboxes.exec(id, ["true"])).rejects.toThrow("没有开着");
    await sandboxes.remove(id);
  });

  it("超时杀掉这个命令起的所有进程（包括转到后台的），别的命令起的不动", async () => {
    const id = randomUUID();
    await sandboxes.ensure(id);
    // 别的命令起的后台进程：守护进程重启也不能停（这里它不带这次命令的标记）
    await sh(id, "sleep 301 >/dev/null 2>&1 &");
    const started = Date.now();
    const r = await sandboxes.exec(id, ["sh", "-c", "sleep 300 & sleep 300"], { timeoutMs: 1000 });
    expect(r).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(20_000);
    const running = async (what: string) =>
      Number(
        (
          await sh(
            id,
            'for f in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$f"; echo; done 2>/dev/null | grep -c "^$1 " || true',
            what,
          )
        ).out,
      );
    expect(await running("sleep 300")).toBe(0);
    expect(await running("sleep 301")).toBe(1);
    // 守护进程重启（新的实例）以后，沙箱里的后台命令还在
    const restarted = new Sandboxes(spec, docker);
    await restarted.ensure(id);
    expect(await running("sleep 301")).toBe(1);
    await sandboxes.remove(id);
  });

  it("AI 标识的开关写进沙箱：准备时写，运行中改了再写；沙箱停着时不写", async () => {
    const id = randomUUID();
    await sandboxes.prepare(id, { signature: true, commitTrailer: false });
    const trailer = async () => (await sh(id, "cat /etc/seekcloud/commit-trailer")).out;
    expect(await trailer()).toBe("off");
    await sandboxes.setAiLabels(id, { signature: true, commitTrailer: true });
    expect(await trailer()).toBe("on");
    await sandboxes.stop(id);
    await sandboxes.setAiLabels(id, { signature: true, commitTrailer: false });
    expect((await sandboxes.find(id))?.state).toBe("stopped");
    await sandboxes.prepare(id, { signature: true, commitTrailer: false });
    expect(await trailer()).toBe("off");
    await sandboxes.destroy(id);
    expect(await sandboxes.count()).toBe(0);
  });

  it("网络：沙箱之间连不通；只连得上网桥地址上放行的端口，宿主机别的端口连不上", async () => {
    const listen = (host: string) =>
      new Promise<number>((resolve) => {
        const server = createServer((socket) => socket.end("hi\n"));
        servers.push(server);
        server.listen(0, host, () => resolve((server.address() as { port: number }).port));
      });
    const allowed = await listen(net.gateway);
    const other = await listen(net.gateway);
    const everywhere = await listen("0.0.0.0");
    await applyFirewall(
      { bridge: net.bridge, gateway: net.gateway, ports: [allowed], chain },
      root,
    );
    // 再加一遍不重复（守护进程每次启动都加）
    await applyFirewall(
      { bridge: net.bridge, gateway: net.gateway, ports: [allowed], chain },
      root,
    );
    const rules = await root("iptables", ["-w", "-S", "INPUT"]);
    expect(rules.stdout.split("\n").filter((l) => l.includes(chain))).toHaveLength(1);

    const a = randomUUID();
    const b = randomUUID();
    await sandboxes.ensure(a);
    await sandboxes.ensure(b);
    const reach = async (from: string, host: string, port: number) =>
      (await sh(from, 'nc -z -w 3 "$1" "$2"', host, String(port))).exitCode === 0;

    expect(await reach(a, net.gateway, allowed)).toBe(true);
    expect(await reach(a, net.gateway, other)).toBe(false);
    expect(await reach(a, net.gateway, everywhere)).toBe(false);

    // b 上开一个端口：宿主机连得上（说明它在听），a 连不上
    await sh(b, "nc -lk -p 8080 -e cat >/dev/null 2>&1 &");
    const ipOfB = (
      await docker.ok([
        "container",
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${spec.network}").IPAddress}}`,
        sandboxes.containerName(b),
      ])
    ).trim();
    await expect.poll(() => canConnect(ipOfB, 8080), { timeout: 10_000 }).toBe(true);
    expect(await reach(a, ipOfB, 8080)).toBe(false);

    if (process.env.SEEKCLOUD_TEST_INTERNET === "1") {
      // 出去上网不受影响，域名也解析得了（测试机上才测：本机的容器出不去）
      expect(await reach(a, "github.com", 443)).toBe(true);
    }
    await sandboxes.remove(a);
    await sandboxes.remove(b);
  });
});

/** 宿主机这边连得上这个地址吗（不靠宿主机装没装 nc）。 */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2000 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
