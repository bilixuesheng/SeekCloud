import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, HostEvent } from "@seekcloud/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeModelServer } from "../testing/fake-model-server";
import { DshAgent } from "./dsh-agent";
import { dshRoute, MODEL_KEY_ENV, modelsPatch } from "./models-config";

/**
 * 测试缝 ③：Agent 适配接口的契约测试（#25）。真的 dsh、真的运行器（本机进程），模型服务是假的、按脚本回复。
 * 以后换别的 Agent，跑同一套。设 SEEKCLOUD_DSH_BIN 才跑（CI 的 dsh 一项）。
 */
const DSH = process.env.SEEKCLOUD_DSH_BIN;
const RUNNER = join(import.meta.dirname, "../../sandbox/runner/seekcloud-runner.mjs");
const BASELINE = join(import.meta.dirname, "../../sandbox/dsh/baseline.patch.yml");
/** 别的提供方的 key（宿主机给的是会话临时令牌）。 */
const MODEL_TOKEN = "session-token-for-providers";

describe.skipIf(!DSH)("Agent 适配接口（dsh）", { timeout: 120_000 }, () => {
  const model = new FakeModelServer();
  let root: string;
  let socket: string;
  let runner: ChildProcess;
  let url: string;
  const agents: DshAgent[] = [];
  const runnerLog: string[] = [];

  beforeAll(async () => {
    url = await model.start();
    root = await mkdtemp(join(tmpdir(), "seekcloud-agent-"));
    socket = join(root, "runner.sock");
    runner = spawn(process.execPath, [RUNNER, "serve", "--socket", socket], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // 运行器出事时（CI 上偶尔连不上它）留个底：退出码和它的报错
    runner.stderr?.on("data", (d: Buffer) => runnerLog.push(String(d).trim()));
    runner.on("exit", (code, signal) => runnerLog.push(`运行器退出了：${code ?? signal}`));
    await mkdir(join(root, "repo"));
    await promisify(execFile)("git", ["init", "-q", join(root, "repo")]);
    // 仓库的 .env 里写了代理变量：dsh 在这样的目录里启动会拒绝（#25），所以启动目录不放在仓库里
    await writeFile(join(root, "repo", ".env"), "HTTPS_PROXY=http://proxy.invalid:3128\n");
    await mkdir(join(root, "dsh-cwd"));
  });
  afterAll(async () => {
    for (const a of agents) a.close();
    runner?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    await model.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  /**
   * 一个会话的 Agent，收到的事件记下来。一个沙箱只有一个运行器、一个 dsh，后连上的顶掉先连上的，
   * 所以先关掉之前的（就像守护进程重启）。
   */
  const agentFor = (sessionId: string, dshArgs?: string[]) => {
    for (const a of agents.splice(0)) a.close();
    const events: HostEvent[] = [];
    const logs: string[] = [];
    const agent = new DshAgent({
      sessionId,
      bridge: () => [process.execPath, RUNNER, "connect", "--socket", socket],
      launch: () => ({
        args: dshArgs ?? [DSH as string, "--profile", "sdk", "--patch", BASELINE],
        cwd: join(root, "dsh-cwd"),
        env: {
          HOME: join(root, "home"),
          DSH_HOME: join(root, "home", ".dsh"),
          DEEPSEEK_API_KEY: "fake-key",
          DEEPSEEK_BASE_URL: url,
          [MODEL_KEY_ENV]: MODEL_TOKEN,
          DSH_PERMISSION_MODE: "danger-full-access",
        },
        workingDirectory: join(root, "repo"),
      }),
      emit: (e) => events.push(e),
      log: (m) => logs.push(m),
      requestTimeoutMs: 30_000,
    });
    agents.push(agent);
    const agentEvents = (turnId: string) =>
      events.flatMap((e) => (e.type === "agent" && e.turnId === turnId ? [e.event] : []));
    const ended = (turnId: string) =>
      until(
        () =>
          agentEvents(turnId).find((e) => e.type === "turn.ended") as
            | (AgentEvent & { type: "turn.ended" })
            | undefined,
      );
    return { agent, events, logs, agentEvents, ended };
  };

  const until = async <T>(check: () => T | undefined | false): Promise<T> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline) {
        throw new Error(`等不到；运行器：${runnerLog.join("\n") || "（没有输出）"}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const turn = (turnId: string, text: string, firstTurn: boolean, modelId = "deepseek-flash") => ({
    turnId,
    text,
    firstTurn,
    model: modelId,
    effort: "high" as const,
  });
  /** 发给模型的最后一个请求的全文。 */
  const lastRequest = () => JSON.stringify(model.messages().at(-1) ?? {});

  const session = randomUUID();
  const first = agentFor(session);

  it("一个回合走完：开始 → 消息 → 工具调用和结果 → 待办 → 回复 → 结束；增量和 token 数也有", async () => {
    model.script = [
      {
        thinking: "先看看",
        tools: [
          { id: "toolu_1", name: "bash", input: { command: "echo 你好", description: "打个招呼" } },
          {
            id: "toolu_2",
            name: "todo_write",
            input: { todos: [{ content: "写代码", status: "in_progress" }] },
          },
        ],
      },
      { text: "都做完了" },
    ];
    await first.agent.startTurn(turn("t1", "开始吧", true));
    const end = await first.ended("t1");
    expect(end).toEqual({ type: "turn.ended", reason: "completed" });
    expect(first.agentEvents("t1").map((e) => e.type)).toEqual([
      "turn.started",
      "message",
      "tool.call",
      "tool.result",
      "tool.call",
      "todo",
      "tool.result",
      "message",
      "turn.ended",
    ]);
    expect(first.agentEvents("t1")).toContainEqual({
      type: "tool.result",
      callId: "toolu_1",
      output: "你好\n",
      isError: false,
    });
    expect(first.agentEvents("t1")).toContainEqual({
      type: "todo",
      items: [{ content: "写代码", status: "in_progress" }],
    });
    expect(first.agentEvents("t1").at(-2)).toEqual({ type: "message", text: "都做完了" });
    expect(first.events).toContainEqual({
      type: "delta",
      sessionId: session,
      turnId: "t1",
      kind: "thinking",
      text: "先看看",
    });
    expect(first.events.some((e) => e.type === "progress" && e.tokens > 0)).toBe(true);
  });

  it("换了模型：重启 dsh、先 resume 再发，模型看得到上一个回合的对话", async () => {
    model.script = [{ text: "换了模型" }];
    await first.agent.startTurn(turn("t2", "第二个回合", false, "deepseek-v4-pro"));
    expect(await first.ended("t2")).toEqual({ type: "turn.ended", reason: "completed" });
    expect(lastRequest()).toContain("都做完了");
    expect(lastRequest()).toContain('"model":"deepseek-v4-pro"');
  });

  it("守护进程重启：新的连接认回运行器，下一个回合接着上一个的对话", async () => {
    first.agent.close();
    const second = agentFor(session);
    model.script = [{ text: "接上了" }];
    await second.agent.startTurn(turn("t3", "守护进程重启以后", false));
    expect(await second.ended("t3")).toEqual({ type: "turn.ended", reason: "completed" });
    expect(lastRequest()).toContain("第二个回合");
    // 重启前那个连接收到过的不会再给新的
    expect(second.agentEvents("t1")).toEqual([]);
  });

  it("回合进行中插话：dsh 读到插的话接着跑，平台的回合只结束一次", async () => {
    const s = agentFor(session);
    model.script = [
      {
        tools: [
          { id: "toolu_s", name: "bash", input: { command: "sleep 2", description: "等一下" } },
        ],
      },
      { text: "第一段" },
      { text: "看到插话了" },
    ];
    await s.agent.startTurn(turn("t4", "做点慢的", false));
    await until(() => s.agentEvents("t4").some((e) => e.type === "tool.call"));
    await s.agent.inject("t4", "顺便看一下 README");
    expect(await s.ended("t4")).toEqual({ type: "turn.ended", reason: "completed" });
    expect(s.agentEvents("t4").filter((e) => e.type === "turn.ended")).toHaveLength(1);
    expect(model.messages().some((m) => JSON.stringify(m).includes("顺便看一下 README"))).toBe(
      true,
    );
  });

  it("停止：停掉 dsh，回合记成已停止；再发消息能接着", async () => {
    const s = agentFor(session);
    model.script = [
      {
        tools: [
          { id: "toolu_l", name: "bash", input: { command: "sleep 60", description: "很慢" } },
        ],
      },
    ];
    await s.agent.startTurn(turn("t5", "做点很慢的", false));
    await until(() => s.agentEvents("t5").some((e) => e.type === "tool.call"));
    await s.agent.stopTurn("t5");
    expect(s.agentEvents("t5").at(-1)).toEqual({ type: "turn.ended", reason: "stopped" });
    model.script = [{ text: "停了以后接着" }];
    await s.agent.startTurn(turn("t6", "接着来", false));
    expect(await s.ended("t6")).toEqual({ type: "turn.ended", reason: "completed" });
  });

  it("dsh 意外退出：回合以内部错误失败（带参考号，原始报错只进日志）；下次发消息重启、resume", async () => {
    const s = agentFor(session);
    // 工具里往上找到 dsh 进程，把它杀掉
    const killDsh =
      'p=$PPID; while [ "$p" -gt 1 ]; do if tr "\\0" " " < /proc/$p/cmdline | grep -q -- "--profile sdk"; then kill -9 $p; break; fi; p=$(awk "{print \\$4}" /proc/$p/stat); done';
    model.script = [
      { tools: [{ id: "toolu_k", name: "bash", input: { command: killDsh, description: "x" } }] },
    ];
    await s.agent.startTurn(turn("t7", "出事", false));
    const end = await s.ended("t7");
    expect(end).toMatchObject({
      type: "turn.ended",
      reason: "failed",
      error: { code: "internal" },
    });
    expect(end.error?.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(s.logs.some((l) => l.includes(end.error?.ref ?? "?") && l.includes("意外退出"))).toBe(
      true,
    );
    model.script = [{ text: "又好了" }];
    await s.agent.startTurn(turn("t8", "再来", false));
    expect(await s.ended("t8")).toEqual({ type: "turn.ended", reason: "completed" });
  });

  it("resume 被拒（dsh 那边没有这个会话）：回合以内部错误失败，不悄悄开一个新会话", async () => {
    const s = agentFor(randomUUID());
    await s.agent.startTurn(turn("t9", "不是第一个回合，但 dsh 没见过", false));
    expect(await s.ended("t9"), [...s.logs, ...runnerLog].join("\n")).toMatchObject({
      type: "turn.ended",
      reason: "failed",
      error: { code: "internal" },
    });
    expect(
      s.logs.some((l) => l.includes("session/resume")),
      [...s.logs, ...runnerLog].join("\n"),
    ).toBe(true);
  });

  it("dsh 起不来：回合以内部错误失败，原始报错只进日志", async () => {
    const s = agentFor(randomUUID(), ["/no/such/dsh"]);
    await s.agent.startTurn(turn("t10", "起不来", true));
    const end = await s.ended("t10");
    expect(end).toMatchObject({
      type: "turn.ended",
      reason: "failed",
      error: { code: "internal" },
    });
    expect(s.logs.some((l) => l.includes(end.error?.ref ?? "?"))).toBe(true);
  });

  it("别的提供方（#188）：自定义的 OpenAI 兼容接口经宿主机的 /v1/providers/<id> 调，key 是会话令牌，模型和路由照配置", async () => {
    const patch = join(root, "models.patch.yml");
    await writeFile(
      patch,
      modelsPatch(
        [
          {
            id: "my-gateway",
            kind: "custom",
            name: "公司网关",
            api: "openai-completions",
            models: [{ id: "gw-model", name: "网关模型", input: ["text"] }],
          },
        ],
        url,
      ),
    );
    const s = agentFor(randomUUID(), [
      DSH as string,
      "--profile",
      "sdk",
      "--patch",
      patch,
      "--patch",
      BASELINE,
    ]);
    const before = model.completions().length;
    model.script = [{ text: "网关回的话" }];
    const route = dshRoute(
      [
        {
          id: "my-gateway",
          kind: "custom",
          name: "公司网关",
          api: "openai-completions",
          models: [{ id: "gw-model" }],
        },
      ],
      "my-gateway",
      "gw-model",
    );
    await s.agent.startTurn({
      ...turn("t11", "用网关的模型", true, "gw-model"),
      provider: route.route,
      reasoning: route.reasoning,
      config: "v1",
    });
    const end = await s.ended("t11");
    expect(end, [...s.logs, ...runnerLog].join("\n")).toEqual({
      type: "turn.ended",
      reason: "completed",
    });
    const request = model.completions().at(before);
    expect(request?.path).toMatch(/^\/v1\/providers\/my-gateway\/chat\/completions/);
    expect(request?.headers.authorization).toBe(`Bearer ${MODEL_TOKEN}`);
    expect((request?.body as { model?: string } | undefined)?.model).toBe("gw-model");
    expect(
      s.agentEvents("t11").some((e) => e.type === "message" && e.text.includes("网关回的话")),
    ).toBe(true);
  });
});
