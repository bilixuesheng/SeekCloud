import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, HostEvent } from "@seekcloud/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxAgents } from "../agent/sandbox-agents";
import { GitSessions } from "../git-proxy/sessions";
import { startGitProxy } from "../git-proxy/start";
import { FakeModelServer } from "../testing/fake-model-server";
import { Docker, runProgram } from "./docker";
import {
  applyFirewall,
  ensureSandboxNetwork,
  removeFirewall,
  removeSandboxNetwork,
  rootViaDocker,
  type SandboxNetwork,
} from "./network";
import { Sandboxes } from "./sandboxes";

/**
 * 在真的沙箱里跑一个回合（#25、#27 之前的整体验证）：用通用镜像（镜像里的运行器和 dsh）、Sysbox、
 * 沙箱专用网络和防火墙，dsh 调模型经 Git 代理端口上的模型网关转发。"主站"是假的：它的模型网关接口
 * 直接由按脚本回复的假模型扮演。
 *
 * 只在测试机上跑：设 SEEKCLOUD_SYSBOX_TESTS=1，SEEKCLOUD_SANDBOX_TEST_IMAGE 指向测试机上构建好的
 * 通用镜像（sandbox-image.yml 构建的 seekcloud-sandbox:ci）。
 */
const IMAGE = process.env.SEEKCLOUD_SANDBOX_TEST_IMAGE;
const enabled = process.env.SEEKCLOUD_SYSBOX_TESTS === "1" && Boolean(IMAGE);
const HELPER = "alpine:3.22";

describe.skipIf(!enabled)("在沙箱里跑一个回合", { timeout: 300_000 }, () => {
  const docker = new Docker();
  const root =
    process.env.SEEKCLOUD_TEST_ROOT === "docker" ? rootViaDocker(HELPER, docker) : runProgram;
  const pool = `r${randomBytes(3).toString("hex")}`;
  const chain = `SC-TEST-${pool}`;
  const model = new FakeModelServer();
  const sessions = new GitSessions();
  const sessionId = randomUUID();
  const events: HostEvent[] = [];
  const logs: string[] = [];
  let dir: string;
  let net: SandboxNetwork;
  let proxy: Server;
  let sandboxes: Sandboxes;
  let agents: SandboxAgents;

  beforeAll(async () => {
    if ((await docker.raw(["image", "inspect", IMAGE as string])).code !== 0) {
      throw new Error(`测试机上没有通用镜像 ${IMAGE}：先跑一次 Sandbox image 工作流`);
    }
    await docker.ensureImage(HELPER);
    dir = await mkdtemp(join(tmpdir(), "seekcloud-turn-"));
    net = await ensureSandboxNetwork(
      { name: `seekcloud-test-${pool}`, bridge: `sc${pool}` },
      docker,
    );

    // 假主站：模型网关的接口（/api/gateway/v1/messages）由假模型回
    const siteUrl = await model.start();
    const key = join(dir, "signing.pem");
    await writeFile(
      key,
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    sessions.register({
      sessionId,
      sessionToken: randomBytes(32).toString("base64url"),
      repos: [],
      aiLabels: { signature: true, commitTrailer: false },
    });
    ({ server: proxy } = startGitProxy(
      {
        dataDir: dir,
        signingKeyPath: key,
        signerEmail: "seekcloud@example.com",
        host: net.gateway,
        port: 0,
      },
      sessions,
      { siteUrl, credential: () => "host-credential" },
    ));
    await new Promise<void>((resolve) =>
      proxy.listening ? resolve() : proxy.once("listening", resolve),
    );
    const port = (proxy.address() as AddressInfo).port;
    await applyFirewall({ bridge: net.bridge, gateway: net.gateway, ports: [port], chain }, root);

    sandboxes = new Sandboxes(
      {
        image: IMAGE as string,
        runtime: "sysbox-runc",
        network: net.name,
        cpus: 2,
        memoryMb: 2048,
        pool,
      },
      docker,
      root,
    );
    agents = new SandboxAgents({
      sandboxes,
      sessions,
      gateway: { host: net.gateway, port },
      emit: (e) => events.push(e),
      log: (m) => logs.push(m),
    });
  });
  afterAll(async () => {
    agents?.close(sessionId);
    if (sandboxes) for (const s of await sandboxes.list()) await sandboxes.remove(s.sessionId);
    if (net) {
      await removeFirewall({ bridge: net.bridge, chain }, root);
      await removeSandboxNetwork(net.name, docker);
    }
    proxy?.close();
    await model.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const agentEvents = () => events.flatMap((e) => (e.type === "agent" ? [e.event] : []));
  const until = async <T>(check: () => T | undefined | false, what: string): Promise<T> => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline)
        throw new Error(`等不到${what}；宿主机日志：\n${logs.slice(-20).join("\n")}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  it("准备沙箱 → 开始回合：沙箱里的 dsh 经模型网关调模型、跑工具，回合走完", async () => {
    await sandboxes.prepare(sessionId, { signature: true, commitTrailer: false });
    model.script = [
      {
        thinking: "看看沙箱",
        tools: [
          {
            id: "toolu_1",
            name: "bash",
            input: {
              command: "echo 在沙箱里 && cat /etc/seekcloud/commit-trailer",
              description: "看看沙箱",
            },
          },
        ],
      },
      { text: "沙箱里一切正常" },
    ];
    await agents.startTurn(sessionId, {
      turnId: "t1",
      text: "看一下沙箱",
      model: "deepseek-flash",
      effort: "high",
      firstTurn: true,
    });
    const end = await until(
      () =>
        agentEvents().find((e) => e.type === "turn.ended") as
          | (AgentEvent & { type: "turn.ended" })
          | undefined,
      "回合结束",
    );
    expect(end, logs.slice(-20).join("\n")).toEqual({ type: "turn.ended", reason: "completed" });
    const result = agentEvents().find((e) => e.type === "tool.result") as AgentEvent & {
      type: "tool.result";
    };
    expect(result.output).toContain("在沙箱里");
    // 准备沙箱时写的 AI 标识开关
    expect(result.output).toContain("off");
    expect(agentEvents().at(-2)).toEqual({ type: "message", text: "沙箱里一切正常" });
    // 逐字输出也过来了
    expect(events).toContainEqual(
      expect.objectContaining({ type: "delta", kind: "thinking", text: "看看沙箱" }),
    );

    // 模型请求经宿主机转发：换上了宿主机凭据和会话 ID，沙箱用的会话临时令牌没有往外带
    const request = model.requests.find((r) => r.path.endsWith("/v1/messages"));
    expect(request?.path).toBe("/api/gateway/v1/messages");
    expect(request?.headers.authorization).toBe("Bearer host-credential");
    expect(request?.headers["x-seekcloud-session"]).toBe(sessionId);
    expect(request?.headers["x-api-key"]).toBeUndefined();
  });
});
