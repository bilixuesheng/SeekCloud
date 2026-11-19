import { execFileSync } from "node:child_process";
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
import { startFakeGitHub } from "../testing/fake-github";
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
import type { SandboxGit } from "./provision";
import { Sandboxes } from "./sandboxes";

/**
 * 在真的沙箱里跑一个回合（#25、#27 之前的整体验证）：用通用镜像（镜像里的运行器和 dsh）、Sysbox、
 * 沙箱专用网络和防火墙，dsh 调模型经 Git 代理端口上的模型网关转发。"主站"是假的：它的模型网关接口
 * 直接由按脚本回复的假模型扮演。GitHub 也是假的（git http-backend），Git 代理把 github.com 转过去：
 * 准备沙箱时真的装 CA、写 git 配置、克隆、切到会话分支，Agent 在主仓库里提交、签名、推送（#27）。
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
  const repoSession = randomUUID();
  const committer = { name: "Mona 测试", email: "1+mona@users.noreply.github.com" };
  const events: HostEvent[] = [];
  const logs: string[] = [];
  let dir: string;
  let net: SandboxNetwork;
  let proxy: Server;
  let git: SandboxGit;
  let github: Awaited<ReturnType<typeof startFakeGitHub>>;
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
    github = await startFakeGitHub("ghu_user");
    github.createRepo("acme/app");
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
      { siteUrl, credential: () => "host-credential" },
    );
    proxy = started.server;
    await new Promise<void>((resolve) =>
      proxy.listening ? resolve() : proxy.once("listening", resolve),
    );
    const port = (proxy.address() as AddressInfo).port;
    git = {
      proxy: { host: net.gateway, port },
      caPem: started.caPem,
      signingPublicKey: started.signingPublicKey,
    };
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
      git,
      emit: (e) => events.push(e),
      log: (m) => logs.push(m),
    });
  }, 180_000);
  afterAll(async () => {
    agents?.close(sessionId);
    agents?.close(repoSession);
    if (sandboxes) for (const s of await sandboxes.list()) await sandboxes.remove(s.sessionId);
    if (net) {
      await removeFirewall({ bridge: net.bridge, chain }, root);
      await removeSandboxNetwork(net.name, docker);
    }
    proxy?.close();
    await model.close();
    await github?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 180_000);

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

  it("有仓库的会话：克隆、切到会话分支，Agent 在主仓库里提交，提交带签名和尾注，推送经 Git 代理到 GitHub", async () => {
    const repo = {
      fullName: "acme/app",
      baseBranch: "main",
      branch: "seekcloud/t2",
      access: "push" as const,
    };
    const sessionToken = randomBytes(32).toString("base64url");
    sessions.register({
      sessionId: repoSession,
      sessionToken,
      repos: [repo],
      workspace: [repo],
      aiLabels: { signature: true, commitTrailer: true },
      committer,
    });
    sessions.setGitHubToken(repoSession, "ghu_user");
    await sandboxes.prepare(
      repoSession,
      { signature: true, commitTrailer: true },
      { git, setup: { sessionToken, committer, repos: [repo] } },
    );

    model.script = [
      {
        tools: [
          {
            id: "toolu_2",
            name: "bash",
            input: {
              command: [
                "pwd",
                "git rev-parse --abbrev-ref HEAD",
                "echo 你好 > hello.txt",
                "git add hello.txt",
                'git commit -q -m "加一个文件"',
                "git push -q origin HEAD 2>&1",
                "echo 推送完成",
                // 留一个没提交的：回合结束时平台补提交、推送
                "echo 草稿 > draft.txt",
              ].join(" && "),
              description: "提交并推送",
            },
          },
        ],
      },
      { text: "推好了" },
    ];
    const before = events.length;
    await agents.startTurn(repoSession, {
      turnId: "t2",
      text: "加一个文件并推送",
      model: "deepseek-flash",
      effort: "high",
      firstTurn: true,
    });
    const mine = () =>
      events
        .slice(before)
        .flatMap((e) => (e.type === "agent" && e.sessionId === repoSession ? [e.event] : []));
    const end = await until(() => mine().find((e) => e.type === "turn.ended"), "第二个回合结束");
    const result = mine().find((e) => e.type === "tool.result") as AgentEvent & {
      type: "tool.result";
    };
    expect(end, `${result?.output}\n${logs.slice(-20).join("\n")}`).toEqual({
      type: "turn.ended",
      reason: "completed",
    });
    expect(result.output).toContain("/workspace/app"); // 工作目录是主仓库
    expect(result.output).toContain("seekcloud/t2");
    expect(result.output).toContain("推送完成");

    // 推到了假 GitHub：会话分支上是 Agent 的提交，提交者是会话的提交身份，带签名和 AI 尾注
    expect(github.refs("acme/app")).toContain("refs/heads/seekcloud/t2");
    const commit = execFileSync("git", ["cat-file", "commit", "refs/heads/seekcloud/t2~1"], {
      cwd: join(github.root, "acme/app.git"),
    }).toString();
    expect(commit).toContain("加一个文件");
    expect(commit).toContain(`committer ${committer.name} <${committer.email}>`);
    expect(commit).toContain("-----BEGIN SSH SIGNATURE-----");
    expect(commit).toContain("Generated-by: SeekCloud (AI)");
    // 回合结束时平台补提交了草稿、推送了会话分支；workspace 在 turn.ended 前面
    const workspace = mine().find((e) => e.type === "workspace") as AgentEvent & {
      type: "workspace";
    };
    expect(mine().indexOf(workspace)).toBe(mine().indexOf(end) - 1);
    const [outcome] = workspace.repos;
    expect(outcome).toMatchObject({ fullName: "acme/app", push: "pushed" });
    expect(outcome?.savedCommit).toBe(outcome?.head);
    expect(outcome?.files.map((f) => f.path).sort()).toEqual(["draft.txt", "hello.txt"]);
    const saved = execFileSync("git", ["cat-file", "commit", "refs/heads/seekcloud/t2"], {
      cwd: join(github.root, "acme/app.git"),
    }).toString();
    expect(saved).toContain("SeekCloud：保存这一回合未提交的改动");
    expect(saved).toContain("-----BEGIN SSH SIGNATURE-----");
    expect(saved).toContain("Generated-by: SeekCloud (AI)");

    // 回合结束以后还有一份对比基础分支的 diff（改动面板）
    const diff = await until(
      () =>
        events.find((e) => e.type === "workspace.diff" && e.sessionId === repoSession) as
          | Extract<HostEvent, { type: "workspace.diff" }>
          | undefined,
      "对比基础分支的 diff",
    );
    expect(diff.repos[0]?.baseBranch).toBe("main");
    expect(diff.repos[0]?.files.map((f) => f.path).sort()).toEqual(["draft.txt", "hello.txt"]);
    expect(diff.repos[0]?.files.find((f) => f.path === "hello.txt")?.patch).toContain("+你好");

    // 推送请求带的是代理换上的用户令牌，沙箱里没有它
    const push = github.requests.find((r) => r.path.endsWith("/git-receive-pack"));
    expect(push?.authorization).toBe(
      `Basic ${Buffer.from("x-access-token:ghu_user").toString("base64")}`,
    );
  });

  it("沙箱被回收以后重建：放回 Agent 的会话文件，Agent 接着原来的对话；工作区从远端的会话分支接着", async () => {
    // 上一个回合结束时发给主站的会话文件
    const archive = await until(
      () =>
        events.find((e) => e.type === "agent.archive" && e.sessionId === repoSession) as
          | Extract<HostEvent, { type: "agent.archive" }>
          | undefined,
      "Agent 的会话文件",
    );
    // 回收：沙箱连同里面的文件一起删掉
    agents.close(repoSession);
    await sandboxes.remove(repoSession);
    expect(await sandboxes.find(repoSession)).toBeUndefined();

    // 重建：准备沙箱（克隆，远端已经有会话分支就接着它），放回会话文件
    const repo = {
      fullName: "acme/app",
      baseBranch: "main",
      branch: "seekcloud/t2",
      access: "push" as const,
    };
    const sessionToken = randomBytes(32).toString("base64url");
    sessions.register({
      sessionId: repoSession,
      sessionToken,
      repos: [repo],
      workspace: [repo],
      aiLabels: { signature: true, commitTrailer: true },
      committer,
    });
    sessions.setGitHubToken(repoSession, "ghu_user");
    await sandboxes.prepare(
      repoSession,
      { signature: true, commitTrailer: true },
      { git, setup: { sessionToken, committer, repos: [repo] } },
    );
    await agents.restore(repoSession, archive.data);

    model.script = [
      {
        tools: [
          {
            id: "toolu_3",
            name: "bash",
            input: { command: "git log --format=%s -3 && ls", description: "看看工作区" },
          },
        ],
      },
      { text: "还记得" },
    ];
    const before = events.length;
    await agents.startTurn(repoSession, {
      turnId: "t3",
      text: "还记得上一回合做了什么吗",
      model: "deepseek-flash",
      effort: "high",
      firstTurn: false,
    });
    const mine = () =>
      events
        .slice(before)
        .flatMap((e) => (e.type === "agent" && e.sessionId === repoSession ? [e.event] : []));
    const end = await until(
      () => mine().find((e) => e.type === "turn.ended"),
      "重建以后的回合结束",
    );
    expect(end, logs.slice(-20).join("\n")).toEqual({ type: "turn.ended", reason: "completed" });
    // 接着原来的会话：发给模型的对话里有上一回合的消息
    const last = model.requests.filter((r) => r.path.endsWith("/v1/messages")).at(-1);
    expect(JSON.stringify(last?.body)).toContain("加一个文件并推送");
    // 工作区接着远端的会话分支：上一回合的提交和补提交的草稿都在
    const result = mine().find((e) => e.type === "tool.result") as AgentEvent & {
      type: "tool.result";
    };
    expect(result.output).toContain("SeekCloud：保存这一回合未提交的改动");
    expect(result.output).toContain("draft.txt");
  });
});
