import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoDiff, SessionEvent } from "@seekcloud/protocol";
import { createTestApp, type TestApp, type TestBrowser } from "@seekcloud/site/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxAgents } from "./agent/sandbox-agents";
import { GitSessions } from "./git-proxy/sessions";
import { startGitProxy } from "./git-proxy/start";
import { Docker, runProgram } from "./sandbox/docker";
import {
  applyFirewall,
  ensureSandboxNetwork,
  removeFirewall,
  removeSandboxNetwork,
  rootViaDocker,
  type SandboxNetwork,
} from "./sandbox/network";
import type { SandboxGit } from "./sandbox/provision";
import { Sandboxes } from "./sandbox/sandboxes";
import { handleCommands } from "./site-link/commands";
import { SiteLink } from "./site-link/connection";
import { startFakeGitHub } from "./testing/fake-github";
import { FakeModelServer } from "./testing/fake-model-server";

/**
 * 第一条真实闭环（#27）的端到端测试：真的主站（进程里起的 HTTP 服务、真的宿主机连接）、真的守护进程部件
 * （主站连接、命令处理、Git 代理和模型网关转发、Sysbox 沙箱、沙箱里的 dsh），只有 GitHub 和模型是假的。
 *
 * 管理员发起会话 → 主站派给宿主机 → 宿主机建沙箱、克隆仓库 → dsh 经模型网关调模型、改代码、提交 →
 * 回合结束时平台补提交、推送 → 主站收到检查点、改动卡片、改动面板的 diff 和 Agent 的会话文件。
 *
 * 只在测试机上跑：要 SEEKCLOUD_SYSBOX_TESTS=1、通用镜像（SEEKCLOUD_SANDBOX_TEST_IMAGE）和主站用的
 * PostgreSQL（TEST_DATABASE_URL，sandbox.yml 起一个容器）。
 */
const IMAGE = process.env.SEEKCLOUD_SANDBOX_TEST_IMAGE;
const enabled =
  process.env.SEEKCLOUD_SYSBOX_TESTS === "1" &&
  Boolean(IMAGE) &&
  Boolean(process.env.TEST_DATABASE_URL);
const HELPER = "alpine:3.22";

describe.skipIf(!enabled)("端到端：真的主站、宿主机、沙箱和 dsh", { timeout: 300_000 }, () => {
  const docker = new Docker();
  const root =
    process.env.SEEKCLOUD_TEST_ROOT === "docker" ? rootViaDocker(HELPER, docker) : runProgram;
  const pool = `e${randomBytes(3).toString("hex")}`;
  const chain = `SC-TEST-${pool}`;
  const model = new FakeModelServer();
  const sessions = new GitSessions();
  const logs: string[] = [];
  let t: TestApp;
  let browser: TestBrowser;
  let github: Awaited<ReturnType<typeof startFakeGitHub>>;
  let dir: string;
  let net: SandboxNetwork;
  let proxy: Server;
  let sandboxes: Sandboxes;
  let agents: SandboxAgents;
  let link: SiteLink;

  beforeAll(async () => {
    if ((await docker.raw(["image", "inspect", IMAGE as string])).code !== 0) {
      throw new Error(`测试机上没有通用镜像 ${IMAGE}：先跑一次 Sandbox image 工作流`);
    }
    await docker.ensureImage(HELPER);
    dir = await mkdtemp(join(tmpdir(), "seekcloud-e2e-"));

    // 主站：真的 HTTP 服务和宿主机连接；模型请求发到按脚本回复的假模型
    const modelUrl = await model.start();
    t = await createTestApp({
      hosts: true,
      modelFetch: fetch,
      modelBaseUrl: `${modelUrl}/anthropic`,
    });
    ({ browser } = await t.adminWithGitHub("octo", "acme/app"));
    const siteUrl = t.hostUrl.replace(/^ws:/, "http:");

    // GitHub：git 部分是真的 git http-backend；令牌是主站的假 GitHub 发的，Git 代理换上它
    github = await startFakeGitHub((token) => token.length > 0);
    github.createRepo("acme/app");

    // 宿主机：网络、防火墙、Git 代理（带模型网关的转发）、沙箱、Agent、命令处理、主站连接
    net = await ensureSandboxNetwork(
      { name: `seekcloud-test-${pool}`, bridge: `sc${pool}` },
      docker,
    );
    const key = join(dir, "signing.pem");
    await writeFile(
      key,
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const started = startGitProxy(
      {
        dataDir: dir,
        signingKeyPath: key,
        signerEmail: "seekcloud@example.com",
        host: net.gateway,
        port: 0,
        upstreams: github.upstreams,
      },
      sessions,
      // 主站的时钟是假的，凭据的过期时间按它算：这里不再按真时间核对
      { siteUrl, credential: () => link?.credential?.token },
    );
    proxy = started.server;
    await new Promise<void>((resolve) =>
      proxy.listening ? resolve() : proxy.once("listening", resolve),
    );
    const port = (proxy.address() as AddressInfo).port;
    await applyFirewall({ bridge: net.bridge, gateway: net.gateway, ports: [port], chain }, root);
    const git: SandboxGit = {
      proxy: { host: net.gateway, port },
      caPem: started.caPem,
      signingPublicKey: started.signingPublicKey,
    };
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
    const send = (event: Parameters<SiteLink["send"]>[0]) => link.send(event);
    agents = new SandboxAgents({ sandboxes, sessions, git, emit: send, log: (m) => logs.push(m) });
    const commands = handleCommands({
      sessions,
      send,
      sandboxes,
      git,
      agents,
      log: (m) => logs.push(m),
    });
    const host = await t.addHost("e2e");
    if (!host.ok) throw new Error(`添加宿主机失败：${host.error}`);
    link = new SiteLink({
      siteUrl,
      key: host.key,
      version: "e2e",
      onCommand: (command) => commands(command),
      log: (m) => logs.push(m),
    });
    link.start();
    const deadline = Date.now() + 30_000;
    while (!link.connected) {
      if (Date.now() > deadline) throw new Error(`宿主机连不上主站：${logs.slice(-10).join("\n")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 300_000);

  afterAll(async () => {
    await link?.stop();
    if (sandboxes) {
      for (const s of await sandboxes.list()) {
        agents?.close(s.sessionId);
        await sandboxes.remove(s.sessionId);
      }
    }
    if (net) {
      await removeFirewall({ bridge: net.bridge, chain }, root);
      await removeSandboxNetwork(net.name, docker);
    }
    proxy?.close();
    await github?.close();
    await model.close();
    await t?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 300_000);

  /** 会话的事件，读到回合结束以后的"等待回复"为止。 */
  const untilWaiting = async (id: string) => {
    const stream = await browser.stream(`/api/sessions/${id}/events`);
    try {
      return (
        await stream.until((e) => {
          const event = JSON.parse(e.data) as SessionEvent;
          return (
            event.type === "status" && (event.status === "waiting" || event.status === "failed")
          );
        }, 240_000)
      ).map((e) => JSON.parse(e.data) as SessionEvent);
    } finally {
      await stream.close();
    }
  };

  it("发起会话：克隆、Agent 改代码并提交、平台补提交和推送；主站收到检查点、改动卡片、diff 和会话文件", async () => {
    model.script = [
      {
        thinking: "加一个文件",
        tools: [
          {
            id: "toolu_e2e",
            name: "bash",
            input: {
              command: [
                "pwd",
                "echo 你好 > hello.txt",
                "git add hello.txt",
                'git commit -q -m "加一个问候"',
                // 留一个没提交的：回合结束时平台补提交
                "echo 草稿 > draft.txt",
                "echo 改好了",
              ].join(" && "),
              description: "改代码",
            },
          },
        ],
      },
      { text: "加了 hello.txt，草稿还没提交。" },
    ];
    const res = await browser.post("/api/sessions", {
      repo: "acme/app",
      baseBranch: "main",
      text: "加一个问候文件",
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { shortId } = (await res.json()) as { shortId: string };

    const events = await untilWaiting(shortId);
    const ended = events.find((e) => e.type === "turn.ended");
    expect(ended, logs.slice(-30).join("\n")).toMatchObject({ reason: "completed" });

    // 工具在主仓库里跑
    const result = events.find((e) => e.type === "tool.result");
    expect(result?.type === "tool.result" && result.output).toContain("/workspace/app");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message", text: "加了 hello.txt，草稿还没提交。" }),
    );

    // 检查点和改动卡片：workspace 在 turn.ended 前面
    const at = events.findIndex((e) => e.type === "workspace");
    const workspace = events[at];
    expect(events[at + 1]?.type).toBe("turn.ended");
    expect(workspace?.type === "workspace" && workspace.repos[0]).toMatchObject({
      fullName: "acme/app",
      push: "pushed",
    });
    expect(
      workspace?.type === "workspace" && workspace.repos[0]?.files.map((f) => f.path).sort(),
    ).toEqual(["draft.txt", "hello.txt"]);

    // 推到了"GitHub"的会话分支：最上面是平台补的提交，下面是 Agent 的；都带签名和尾注
    const bare = join(github.root, "acme/app.git");
    const branch = `refs/heads/seekcloud/${shortId}`;
    expect(github.refs("acme/app")).toContain(branch);
    const saved = execFileSync("git", ["cat-file", "commit", branch], { cwd: bare }).toString();
    expect(saved).toContain("SeekCloud：保存第 1 回合未提交的改动");
    expect(saved).toContain("-----BEGIN SSH SIGNATURE-----");
    expect(saved).toContain("Generated-by: SeekCloud (AI)");
    const agentCommit = execFileSync("git", ["cat-file", "commit", `${branch}~1`], {
      cwd: bare,
    }).toString();
    expect(agentCommit).toContain("加一个问候");
    expect(agentCommit).toContain("-----BEGIN SSH SIGNATURE-----");

    // 改动面板：对比基础分支的 diff（回合结束以后才算，等一会儿）
    let diff: RepoDiff[] = [];
    for (let i = 0; i < 100 && diff.length === 0; i++) {
      diff = (
        (await (await browser.get(`/api/sessions/${shortId}/diff`)).json()) as {
          repos: RepoDiff[];
        }
      ).repos;
      if (diff.length === 0) await new Promise((r) => setTimeout(r, 200));
    }
    expect(diff[0]?.files.find((f) => f.path === "hello.txt")?.patch).toContain("+你好");

    // Agent 的会话文件存到了主站
    let archives: string[] = [];
    for (let i = 0; i < 100 && archives.length === 0; i++) {
      archives = await readdir(join(t.dataDir, "agent-sessions")).catch(() => []);
      if (archives.length === 0) await new Promise((r) => setTimeout(r, 200));
    }
    expect(archives.filter((f) => f.endsWith(".tar.gz"))).toHaveLength(1);

    // 模型请求经宿主机转发到主站的模型网关，再到"提供方"：带的是主站的 key，不是会话临时令牌
    const upstream = model.requests.find((r) => r.path.endsWith("/v1/messages"));
    expect(upstream?.path).toBe("/anthropic/v1/messages");
  });
});
