import { randomBytes, randomUUID } from "node:crypto";
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
 * 测试缝 ②（Sysbox 才有的）：沙箱里跑 Docker、用户映射、沙箱里看得到的资源上限、沙箱里 Docker 的数据跟着沙箱走。
 * 只在测试机上跑（.github/workflows/sandbox.yml 设 SEEKCLOUD_SYSBOX_TESTS=1）。镜像用 docker:dind，
 * 它的入口会在沙箱里起 Docker；通用镜像（#17）做好以后换成它。
 */
const enabled = process.env.SEEKCLOUD_SYSBOX_TESTS === "1";
const IMAGE = "docker:29-dind";
const HELPER = "alpine:3.22";

describe.skipIf(!enabled)("Sysbox 沙箱", { timeout: 300_000 }, () => {
  const docker = new Docker();
  const root =
    process.env.SEEKCLOUD_TEST_ROOT === "docker" ? rootViaDocker(HELPER, docker) : runProgram;
  const pool = `s${randomBytes(3).toString("hex")}`;
  const chain = `SC-TEST-${pool}`;
  const spec: SandboxSpec = {
    image: IMAGE,
    runtime: "sysbox-runc",
    network: `seekcloud-test-${pool}`,
    cpus: 1.5,
    memoryMb: 1024,
    pool,
  };
  let net: SandboxNetwork;
  let sandboxes: Sandboxes;
  const id = randomUUID();

  beforeAll(async () => {
    await docker.ensureImage(IMAGE);
    await docker.ensureImage(HELPER);
    net = await ensureSandboxNetwork({ name: spec.network, bridge: `sc${pool}` }, docker);
    // 和正式环境一样加上防火墙：沙箱里的 Docker 照样拉得到镜像
    await applyFirewall({ bridge: net.bridge, gateway: net.gateway, ports: [], chain }, root);
    sandboxes = new Sandboxes(spec, docker);
  });
  afterAll(async () => {
    if (!sandboxes) return;
    for (const s of await sandboxes.list()) await sandboxes.remove(s.sessionId);
    await removeFirewall({ bridge: net.bridge, chain }, root);
    await removeSandboxNetwork(spec.network, docker);
  });

  const sh = async (script: string) => {
    const r = await sandboxes.exec(id, ["sh", "-c", script], { timeoutMs: 120_000 });
    return { ...r, out: r.stdout.trim() };
  };
  const dockerReady = () =>
    expect
      .poll(async () => (await sh("docker info >/dev/null 2>&1")).exitCode, {
        timeout: 60_000,
        interval: 1000,
      })
      .toBe(0);

  it("沙箱里能跑 Docker；沙箱里的 root 映射成宿主机上的普通用户；CPU、内存的上限在沙箱里看得到", async () => {
    await sandboxes.ensure(id);
    await dockerReady();
    const hello = await sh("docker run --rm hello-world");
    expect(hello.exitCode, hello.stderr).toBe(0);
    expect(hello.out).toContain("Hello from Docker");

    const [inside, outside] = (await sh("head -n1 /proc/self/uid_map")).out.split(/\s+/);
    expect(inside).toBe("0");
    expect(outside).not.toBe("0");

    expect((await sh("cat /sys/fs/cgroup/memory.max")).out).toBe(String(1024 * 1024 * 1024));
    expect((await sh("cat /sys/fs/cgroup/cpu.max")).out).toBe("150000 100000");
  });

  it("停止再启动，沙箱里 Docker 的镜像还在；删除以后宿主机上 Sysbox 给它的目录也没了", async () => {
    const before = await sandboxes.ensure(id);
    await sandboxes.stop(id);
    expect((await sandboxes.find(id))?.state).toBe("stopped");
    await sandboxes.ensure(id);
    await dockerReady();
    expect((await sh("docker images --quiet hello-world")).out).not.toBe("");

    // Sysbox 把沙箱里的 /var/lib/docker 放在宿主机的 /var/lib/sysbox 下面，目录名带着容器 ID
    const sysboxDirs = async () =>
      (
        await root("find", ["/var/lib/sysbox", "-maxdepth", "3", "-name", `${before.containerId}*`])
      ).stdout
        .split("\n")
        .filter(Boolean);
    expect(await sysboxDirs()).not.toEqual([]);
    await sandboxes.remove(id);
    expect(await sandboxes.find(id)).toBeUndefined();
    expect(await sysboxDirs()).toEqual([]);
  });
});
