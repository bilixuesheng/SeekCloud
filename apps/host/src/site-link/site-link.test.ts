import type { AddressInfo } from "node:net";
import {
  HOST_CONNECT_PATH,
  type HostCommand,
  type HostEvent,
  LINK_CLOSE,
  PROTOCOL_VERSION,
} from "@seekcloud/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { AgentHost } from "../agent/sandbox-agents";
import { GitSessions } from "../git-proxy/sessions";
import type { SandboxHost } from "../sandbox/sandboxes";
import { handleCommands } from "./commands";
import { connectUrl, SiteLink } from "./connection";

/**
 * 测试缝 ②（协议部分）：测试扮演主站，按协议驱动宿主机守护进程的连接模块。
 * 认证、派会话这些主站那边的规矩在 apps/site 的 hosts/hub.test.ts 里测；这里测守护进程这一半。
 */
class FakeSite {
  readonly server: WebSocketServer;
  readonly hellos: Record<string, unknown>[] = [];
  /** 收到的每一帧（握手以后的），原样记下。 */
  readonly frames: Record<string, unknown>[] = [];
  socket: WebSocket | undefined;
  instance = "site-1";
  /** 主站处理到的宿主机帧的序号，握手时告诉宿主机。 */
  received = 0;
  /** 连上来时怎么回：欢迎，或者用某个代码关掉。 */
  answer: "welcome" | number = "welcome";
  #seq = 0;

  constructor() {
    this.server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: HOST_CONNECT_PATH });
    this.server.on("connection", (socket) => {
      socket.once("message", (data) => {
        const hello = JSON.parse(String(data)).hello;
        this.hellos.push(hello);
        if (this.answer !== "welcome") {
          socket.close(this.answer, "no");
          return;
        }
        this.socket = socket;
        socket.on("message", (d) => this.frames.push(JSON.parse(String(d))));
        socket.send(
          JSON.stringify({
            welcome: {
              name: "test-host",
              protocol: PROTOCOL_VERSION,
              version: "site-test",
              instance: this.instance,
              ack: this.received,
              credential: {
                token: `cred-${this.hellos.length}`,
                expiresAt: "2099-01-01T00:00:00Z",
              },
            },
          }),
        );
      });
    });
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** 发一条命令。seq 不给就往下数。 */
  command(command: HostCommand, seq = ++this.#seq): number {
    this.socket?.send(JSON.stringify({ seq, ack: this.received, command }));
    return seq;
  }

  /** 主站重启：换一个标识，序号从头数，没处理过任何宿主机的帧。 */
  restart(): void {
    this.instance = `site-${Math.random()}`;
    this.#seq = 0;
    this.received = 0;
  }

  events(): { seq: number; event: HostEvent }[] {
    return this.frames.filter((f) => "event" in f) as { seq: number; event: HostEvent }[];
  }

  /** 宿主机确认处理到了哪一个主站的帧。 */
  lastAck(): number {
    return Math.max(0, ...this.frames.map((f) => f.ack as number));
  }

  async until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("等太久了");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async close(): Promise<void> {
    for (const client of this.server.clients) client.terminate();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

describe("宿主机到主站的连接", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  /** 一个假主站，加一个连上它的守护进程。 */
  const setup = async (sandboxes?: SandboxHost, agents?: AgentHost) => {
    const site = new FakeSite();
    await new Promise((resolve) => site.server.once("listening", resolve));
    const sessions = new GitSessions();
    const handled: HostCommand[] = [];
    const logs: string[] = [];
    const link: SiteLink = new SiteLink({
      siteUrl: site.url,
      key: "schk_test-key",
      version: "9.9.9",
      onCommand: async (command) => {
        handled.push(command);
        await commands(command);
      },
      backoff: { initialMs: 20, maxMs: 100 },
      log: (m) => logs.push(m),
    });
    const commands = handleCommands({
      sessions,
      send: (e) => link.send(e),
      sandboxes,
      agents,
      log: (m) => logs.push(m),
    });
    cleanup.push(async () => {
      await link.stop();
      await site.close();
    });
    link.start();
    await site.until(() => link.connected);
    return { site, link, sessions, handled, logs };
  };

  it("主站的地址换成 WebSocket 的连接地址", () => {
    expect(connectUrl("https://seekcloud.example.com")).toBe(
      `wss://seekcloud.example.com${HOST_CONNECT_PATH}`,
    );
    expect(connectUrl("http://10.0.0.2:3000/")).toBe(`ws://10.0.0.2:3000${HOST_CONNECT_PATH}`);
  });

  it("连上时带上密钥、协议版本、程序版本和这次启动的标识；拿到宿主机凭据", async () => {
    const { site, link } = await setup();
    expect(site.hellos[0]).toEqual({
      key: "schk_test-key",
      protocol: PROTOCOL_VERSION,
      minProtocol: 1,
      version: "9.9.9",
      instance: link.instance,
      ack: 0,
    });
    expect(link.credential?.token).toBe("cred-1");
    expect(link.protocol).toBe(PROTOCOL_VERSION);
  });

  it("主站的命令进 Git 代理的会话表；没配沙箱时准备沙箱回建不了，回合照失败结束", async () => {
    const { site, sessions } = await setup();
    const repos = [
      {
        fullName: "octo/app",
        baseBranch: "main",
        branch: "seekcloud/abc",
        access: "push" as const,
      },
    ];
    site.command({
      type: "prepare_sandbox",
      sessionId: "s1",
      repos,
      environmentId: "e1",
      model: "m",
      effort: "high",
      aiLabels: { signature: false, commitTrailer: true },
    });
    site.command({ type: "set_github_token", sessionId: "s1", token: "gho_x" });
    site.command({
      type: "set_ai_labels",
      sessionId: "s1",
      aiLabels: { signature: true, commitTrailer: false },
    });
    site.command({
      type: "start_turn",
      sessionId: "s1",
      turnId: "t1",
      text: "hi",
      model: "m",
      effort: "high",
    });
    await site.until(() => site.events().length === 2);
    expect(site.events().map((e) => e.event)).toEqual([
      { type: "sandbox.failed", sessionId: "s1", error: { code: "sandbox_unavailable" } },
      {
        type: "agent",
        sessionId: "s1",
        turnId: "t1",
        event: { type: "turn.ended", reason: "failed", error: { code: "sandbox_unavailable" } },
      },
    ]);
    const session = sessions.get("s1");
    expect(session).toMatchObject({
      repos: [{ fullName: "octo/app", access: "push" }],
      githubToken: "gho_x",
      aiLabels: { signature: true, commitTrailer: false },
    });
    expect(session?.sessionToken).toMatch(/^[\w-]{43}$/);

    site.command({ type: "destroy_sandbox", sessionId: "s1" });
    await site.until(() => site.lastAck() === 5);
    expect(sessions.get("s1")).toBeUndefined();
  });

  it("有沙箱时：建好回沙箱好了，建不了回建不了并带参考号（原始报错只进日志）；同一个会话的操作按顺序做，慢的不挡别的会话", async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sandboxes: SandboxHost = {
      async prepare(sessionId, aiLabels) {
        calls.push(`prepare ${sessionId} ${aiLabels.commitTrailer}`);
        if (sessionId === "slow") await slow;
        if (sessionId === "broken") throw new Error("docker 说：镜像拉不下来（内部地址 10.0.0.1）");
      },
      async setAiLabels(sessionId, aiLabels) {
        calls.push(`labels ${sessionId} ${aiLabels.commitTrailer}`);
      },
      async destroy(sessionId) {
        calls.push(`destroy ${sessionId}`);
      },
      async count() {
        return 0;
      },
    };
    const { site, logs } = await setup(sandboxes);
    const prepare = (sessionId: string) =>
      site.command({
        type: "prepare_sandbox",
        sessionId,
        repos: [],
        environmentId: "e1",
        model: "m",
        effort: "high",
        aiLabels: { signature: true, commitTrailer: true },
      });
    prepare("slow");
    site.command({
      type: "set_ai_labels",
      sessionId: "slow",
      aiLabels: { signature: true, commitTrailer: false },
    });
    site.command({ type: "destroy_sandbox", sessionId: "slow" });
    prepare("broken");
    prepare("ok");
    // slow 还没建好，别的会话照样处理完
    await site.until(() => site.events().length === 2);
    const events = site.events().map((e) => e.event);
    expect(events).toContainEqual({ type: "sandbox.ready", sessionId: "ok" });
    const failed = events.find((e) => e.type === "sandbox.failed") as {
      error: { code: string; ref: string };
    };
    expect(failed).toMatchObject({ sessionId: "broken", error: { code: "sandbox_unavailable" } });
    expect(failed.error.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(failed)).not.toContain("10.0.0.1");
    expect(logs.some((l) => l.includes(failed.error.ref) && l.includes("镜像拉不下来"))).toBe(true);
    expect(calls.filter((c) => c.includes("slow"))).toEqual(["prepare slow true"]);

    release();
    await site.until(() => site.events().length === 3);
    expect(site.events()[2]?.event).toEqual({ type: "sandbox.ready", sessionId: "slow" });
    await site.until(() => calls.includes("destroy slow"));
    expect(calls.filter((c) => c.includes("slow"))).toEqual([
      "prepare slow true",
      "labels slow false",
      "destroy slow",
    ]);

    // Agent 还没接上（#25）：回合照失败结束
    site.command({
      type: "start_turn",
      sessionId: "ok",
      turnId: "t1",
      text: "hi",
      model: "m",
      effort: "high",
    });
    await site.until(() => site.events().length === 4);
    expect(site.events()[3]?.event).toMatchObject({
      type: "agent",
      event: { type: "turn.ended", reason: "failed", error: { code: "internal" } },
    });
  });

  it("有 Agent 时：开始回合交给它（带上是不是第一个回合），插话、停止也转过去；删除沙箱时先断开它", async () => {
    const calls: unknown[] = [];
    const agents: AgentHost = {
      async startTurn(sessionId, input) {
        calls.push(["start", sessionId, input]);
      },
      async inject(sessionId, turnId, text) {
        calls.push(["inject", sessionId, turnId, text]);
      },
      async stopTurn(sessionId, turnId) {
        calls.push(["stop", sessionId, turnId]);
      },
      close(sessionId) {
        calls.push(["close", sessionId]);
      },
    };
    const { site } = await setup(undefined, agents);
    site.command({
      type: "start_turn",
      sessionId: "s1",
      turnId: "t1",
      text: "hi",
      model: "deepseek-flash",
      effort: "high",
      firstTurn: true,
    });
    site.command({ type: "inject_message", sessionId: "s1", turnId: "t1", text: "插话" });
    site.command({ type: "stop_turn", sessionId: "s1", turnId: "t1" });
    // 旧版本的主站不填 firstTurn：按不是第一个回合处理
    site.command({
      type: "start_turn",
      sessionId: "s1",
      turnId: "t2",
      text: "again",
      model: "deepseek-flash",
      effort: "low",
    });
    site.command({ type: "destroy_sandbox", sessionId: "s1" });
    await site.until(() => calls.length === 5);
    expect(calls).toContainEqual([
      "start",
      "s1",
      { turnId: "t1", text: "hi", model: "deepseek-flash", effort: "high", firstTurn: true },
    ]);
    expect(calls).toContainEqual(["inject", "s1", "t1", "插话"]);
    expect(calls).toContainEqual(["stop", "s1", "t1"]);
    expect(calls).toContainEqual([
      "start",
      "s1",
      { turnId: "t2", text: "again", model: "deepseek-flash", effort: "low", firstTurn: false },
    ]);
    expect(calls).toContainEqual(["close", "s1"]);
    // 回合交给 Agent 以后，不再替它回失败
    expect(site.events()).toEqual([]);
  });

  it("不认识的命令（主站比宿主机新）记一笔、照样确认", async () => {
    const { site, logs } = await setup();
    const seq = site.command({ type: "hibernate_sandbox", sessionId: "s1" } as never);
    await site.until(() => site.lastAck() >= seq);
    expect(logs.some((l) => l.includes("hibernate_sandbox"))).toBe(true);
  });

  it("重复的命令只处理一次", async () => {
    const { site, handled } = await setup();
    const command: HostCommand = { type: "destroy_sandbox", sessionId: "s9" };
    const seq = site.command(command);
    site.command(command, seq);
    site.command({ type: "destroy_sandbox", sessionId: "s10" });
    await site.until(() => site.lastAck() === seq + 1);
    expect(handled.map((c) => (c as { sessionId: string }).sessionId)).toEqual(["s9", "s10"]);
  });

  it("断线以后自动重连，带上处理到的序号；主站没确认的事件补发，主站补发的旧命令不再处理", async () => {
    const { site, link, handled } = await setup();
    const first = site.command({ type: "destroy_sandbox", sessionId: "a" });
    await site.until(() => site.lastAck() === first);
    // 宿主机上报了一个事件，主站还没处理（没确认）就断了
    link.send({ type: "sandbox.ready", sessionId: "a" });
    await site.until(() => site.events().length === 1);
    site.socket?.terminate();

    await site.until(() => site.hellos.length === 2);
    expect(site.hellos[1]).toMatchObject({ instance: link.instance, ack: first });
    await site.until(() => site.events().length === 2);
    expect(site.events()[1]).toEqual(site.events()[0]);

    // 主站不知道宿主机处理过没有，把旧命令再发一遍：不再处理
    site.command({ type: "destroy_sandbox", sessionId: "a" }, first);
    const next = site.command({ type: "destroy_sandbox", sessionId: "b" });
    await site.until(() => site.lastAck() === next);
    expect(handled.map((c) => (c as { sessionId: string }).sessionId)).toEqual(["a", "b"]);
  });

  it("主站重启（标识变了）：主站的序号从头数，宿主机照收；主站确认过的事件不再补发", async () => {
    const { site, link, handled } = await setup();
    site.command({ type: "destroy_sandbox", sessionId: "before" });
    link.send({ type: "sandbox.ready", sessionId: "x" });
    await site.until(() => site.events().length === 1);
    // 新的主站进程从库里接上：宿主机的事件处理到了第 1 个
    site.restart();
    site.received = 1;
    site.socket?.terminate();
    await site.until(() => site.hellos.length === 2);
    await site.until(() => link.connected);
    site.command({ type: "destroy_sandbox", sessionId: "after" });
    await site.until(() => handled.length === 2);
    expect(handled.map((c) => (c as { sessionId: string }).sessionId)).toEqual(["before", "after"]);
    // 主站说处理到了 1：那个事件不补发
    await new Promise((r) => setTimeout(r, 50));
    expect(site.events()).toHaveLength(1);
  });

  it("主站说密钥不对（或被吊销）：不再重连；限速时过一会儿再连", async () => {
    const { site, link, logs } = await setup();
    site.answer = LINK_CLOSE.RATE_LIMITED;
    site.socket?.terminate();
    await site.until(() => site.hellos.length === 2);
    site.answer = LINK_CLOSE.UNAUTHORIZED;
    await site.until(() => site.hellos.length === 3, 5000);
    await new Promise((r) => setTimeout(r, 300));
    expect(site.hellos).toHaveLength(3);
    expect(link.connected).toBe(false);
    expect(logs.some((l) => l.includes("不再重连"))).toBe(true);
  });

  it("连着时上报负载，断线时不攒着", async () => {
    const { site, link } = await setup();
    const report = {
      load: 1,
      cpus: 2,
      memoryAvailable: 1,
      memoryTotal: 2,
      diskAvailable: 3,
      diskTotal: 4,
      sandboxes: 0,
    };
    link.report(report);
    await site.until(() => site.frames.some((f) => "report" in f));
    expect(site.frames.find((f) => "report" in f)).toEqual({ ack: 0, report });
  });
});
