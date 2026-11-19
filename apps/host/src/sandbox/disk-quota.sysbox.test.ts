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
 * 沙箱的磁盘额度（#168）在真的 Sysbox 上：
 *
 * - 沙箱里的 /var/lib/docker 挂宿主机上它自己的目录，沙箱里的 Docker 照样能跑，休眠再启动镜像还在，删沙箱时目录一起删；
 * - 测试机的存储是开了 prjquota 的 XFS 时（scripts/test-machine.sh 的"沙箱的存储"）：写超过上限报
 *   No space left on device，删了能再写；沙箱里 Docker 的数据和可写层算在同一份额度里；两个沙箱互不影响。
 *   存储还不是 XFS 时这一半跳过，日志里写明原因。
 *
 * 只在测试机上跑（SEEKCLOUD_SYSBOX_TESTS=1）。
 */
const enabled = process.env.SEEKCLOUD_SYSBOX_TESTS === "1";
const IMAGE = "docker:29-dind";
const HELPER = "alpine:3.22";
const LIMIT_GB = 1;

describe.skipIf(!enabled)("沙箱的磁盘额度（Sysbox）", { timeout: 300_000 }, () => {
  const docker = new Docker();
  const root =
    process.env.SEEKCLOUD_TEST_ROOT === "docker" ? rootViaDocker(HELPER, docker) : runProgram;
  const pool = `q${randomBytes(3).toString("hex")}`;
  const chain = `SC-TEST-${pool}`;
  // 放在 /var/lib/seekcloud 下面：开了磁盘配额的测试机上，这里在那块 XFS 上
  const dir = `/var/lib/seekcloud/test-${pool}`;
  const spec: SandboxSpec = {
    image: IMAGE,
    runtime: "sysbox-runc",
    network: `seekcloud-test-${pool}`,
    cpus: 1.5,
    memoryMb: 1024,
    pool,
    storage: { dir, limitGb: LIMIT_GB },
  };
  let net: SandboxNetwork;
  let sandboxes: Sandboxes;
  const a = randomUUID();
  const b = randomUUID();

  beforeAll(async () => {
    await docker.ensureImage(IMAGE);
    await docker.ensureImage(HELPER);
    net = await ensureSandboxNetwork({ name: spec.network, bridge: `sc${pool}` }, docker);
    await applyFirewall({ bridge: net.bridge, gateway: net.gateway, ports: [], chain }, root);
    sandboxes = new Sandboxes(spec, docker, root);
  });
  afterAll(async () => {
    if (sandboxes) for (const s of await sandboxes.list()) await sandboxes.remove(s.sessionId);
    if (net) {
      await removeFirewall({ bridge: net.bridge, chain }, root);
      await removeSandboxNetwork(spec.network, docker);
    }
    await root("rm", ["-rf", "--", dir]);
  });

  const sh = async (id: string, script: string) => {
    const r = await sandboxes.exec(id, ["sh", "-c", script], { timeoutMs: 180_000 });
    return { ...r, out: `${r.stdout}${r.stderr}`.trim() };
  };
  const dockerReady = (id: string) =>
    expect
      .poll(async () => (await sh(id, "docker info >/dev/null 2>&1")).exitCode, {
        timeout: 60_000,
        interval: 1000,
      })
      .toBe(0);

  it("沙箱里的 /var/lib/docker 是宿主机上它自己的目录：Docker 照样跑，休眠再启动镜像还在，删沙箱时一起删", async () => {
    await sandboxes.ensure(a);
    await dockerReady(a);
    const hello = await sh(a, "docker run --rm hello-world");
    expect(hello.exitCode, hello.out).toBe(0);
    // 镜像落在宿主机上这个沙箱自己的目录里
    const onHost = await root("find", [`${dir}/${a}/docker`, "-maxdepth", "1"]);
    expect(onHost.stdout.split("\n").length).toBeGreaterThan(2);

    await sandboxes.stop(a);
    await sandboxes.ensure(a);
    await dockerReady(a);
    expect((await sh(a, "docker images --quiet hello-world")).out).not.toBe("");
  });

  it("存储是开了项目配额的 XFS 时：写超过上限报磁盘已满，删了能再写；沙箱里 Docker 的数据算在同一份额度里；两个沙箱互不影响", async (ctx) => {
    const quota = await sandboxes.diskQuota();
    if (!quota.ok) {
      console.log(`测试机的存储还不能限单个沙箱（${quota.reason}），跳过这一半`);
      ctx.skip();
      return;
    }
    await sandboxes.ensure(a);
    // 可写层：写到上限就失败，报的是磁盘已满
    const full = await sh(a, `dd if=/dev/zero of=/root/fill bs=1M count=${LIMIT_GB * 1024 + 200}`);
    expect(full.exitCode).not.toBe(0);
    expect(full.out).toContain("No space left on device");
    // 删了马上能写
    expect(
      (await sh(a, "rm -f /root/fill && dd if=/dev/zero of=/root/small bs=1M count=100")).exitCode,
    ).toBe(0);
    // 沙箱里 Docker 的目录和可写层共用一份：两边各写一半多一点，第二份写不下
    const half = Math.ceil((LIMIT_GB * 1024) / 2) + 100;
    expect(
      (await sh(a, `dd if=/dev/zero of=/var/lib/docker/fill bs=1M count=${half}`)).exitCode,
    ).toBe(0);
    const second = await sh(a, `dd if=/dev/zero of=/root/fill bs=1M count=${half}`);
    expect(second.exitCode).not.toBe(0);
    expect(second.out).toContain("No space left on device");

    // 另一个沙箱不受影响
    await sandboxes.ensure(b);
    expect((await sh(b, "dd if=/dev/zero of=/root/fill bs=1M count=500")).exitCode).toBe(0);

    // 休眠再启动、守护进程重启（新的 Sandboxes 认回）以后，上限照旧
    await sandboxes.stop(a);
    const restarted = new Sandboxes(spec, docker, root);
    await restarted.ensure(a);
    const again = await sh(a, `dd if=/dev/zero of=/root/more bs=1M count=${half}`);
    expect(again.exitCode).not.toBe(0);
    expect(again.out).toContain("No space left on device");
  });
});
