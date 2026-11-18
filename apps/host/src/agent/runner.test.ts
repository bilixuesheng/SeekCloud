import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunnerEntry, RunnerLink, type RunnerWelcome } from "./runner-link";

/**
 * 运行器（apps/host/sandbox/runner/seekcloud-runner.mjs）和守护进程这边的连接（runner-link.ts）。
 * 运行器在本机起（沙箱里是 docker exec），"dsh" 换成一个假的小程序：把收到的每一行原样回到标准输出，
 * 同时往第 4 个文件描述符和标准错误各写一行。
 */
const RUNNER = join(import.meta.dirname, "../../sandbox/runner/seekcloud-runner.mjs");

const FAKE_DSH = `
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
const live = createWriteStream("", { fd: Number(process.env.SEEKCLOUD_LIVE_FD), autoClose: false });
process.stderr.write("假 dsh 起来了 " + (process.env.GREETING ?? "") + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "exit 3") process.exit(3);
  if (line === "spawn-child") {
    const c = spawn("sleep", ["300"], { stdio: "ignore" });
    process.stdout.write(JSON.stringify({ child: c.pid }) + "\\n");
    return;
  }
  live.write(JSON.stringify({ kind: "text", text: line }) + "\\n");
  process.stdout.write(JSON.stringify({ echo: line }) + "\\n");
});
`;

describe("运行器", { timeout: 30_000 }, () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), "seekcloud-runner-"));
    const socket = join(dir, "runner.sock");
    const fake = join(dir, "fake-dsh.mjs");
    await writeFile(fake, FAKE_DSH);
    const serve = (): ChildProcess =>
      spawn(process.execPath, [RUNNER, "serve", "--socket", socket], { stdio: "ignore" });
    const server = serve();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    cleanup.push(() => server.kill("SIGKILL"));
    const bridge = () => [process.execPath, RUNNER, "connect", "--socket", socket];

    /** 一个守护进程：连上运行器，收到的条目记下来。 */
    const daemon = (slowMs = 0) => {
      const entries: RunnerEntry[] = [];
      const welcomes: { welcome: RunnerWelcome; changed: boolean }[] = [];
      const link = new RunnerLink({
        bridge,
        retryMs: 50,
        log: () => {},
        onEntry: async (entry) => {
          if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
          entries.push(entry);
        },
        onWelcome: (welcome, changed) => {
          welcomes.push({ welcome, changed });
        },
      });
      link.start();
      cleanup.push(() => link.stop());
      return { link, entries, welcomes };
    };
    const until = async (check: () => boolean, what = "条件") => {
      const deadline = Date.now() + 10_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`等不到${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const startFake = (link: RunnerLink) =>
      link.send({
        op: "start",
        args: [process.execPath, fake],
        cwd: dir,
        env: { GREETING: "你好" },
      });
    return { dir, socket, serve, server, daemon, until, startFake };
  };

  const rpc = (entries: RunnerEntry[]) =>
    entries.flatMap((e) => (e.type === "rpc" ? [JSON.parse(e.line)] : []));

  it("起 dsh、往里写；收到它的标准输出、第 4 个描述符和标准错误；退出时收到退出码", async () => {
    const { daemon, until, startFake } = await setup();
    const { link, entries, welcomes } = daemon();
    await until(() => link.connected, "连上");
    expect(welcomes[0]?.welcome).toMatchObject({ running: false, pid: null, gap: false });
    startFake(link);
    // 已经在跑时再 start 不会起第二个
    startFake(link);
    link.send({ op: "send", line: "第一行" });
    await until(() => rpc(entries).length === 1, "回显");
    expect(rpc(entries)).toEqual([{ echo: "第一行" }]);
    expect(entries.filter((e) => e.type === "started")).toHaveLength(1);
    expect(entries.find((e) => e.type === "live")).toMatchObject({
      line: JSON.stringify({ kind: "text", text: "第一行" }),
    });
    await until(() => entries.some((e) => e.type === "stderr"), "标准错误");
    expect(entries.find((e) => e.type === "stderr")).toMatchObject({ text: "假 dsh 起来了 你好" });

    link.send({ op: "send", line: "exit 3" });
    await until(() => entries.some((e) => e.type === "exit"), "退出");
    expect(entries.find((e) => e.type === "exit")).toMatchObject({ code: 3, signal: null });
    // 编号连续、从小到大，每个只出现一次
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // dsh 退了以后再写：报错误条目，不会悄悄丢
    link.send({ op: "send", line: "没人收" });
    await until(() => entries.some((e) => e.type === "error"), "错误");
  });

  it("守护进程重启（新的连接，什么都没记着）：只补发没确认的，确认过的不重复；dsh 一直在跑", async () => {
    const { daemon, until, startFake } = await setup();
    const first = daemon();
    await until(() => first.link.connected, "连上");
    startFake(first.link);
    first.link.send({ op: "send", line: "一" });
    await until(() => rpc(first.entries).length === 1, "回显");
    await first.link.idle();
    // 等确认送到运行器
    await new Promise((r) => setTimeout(r, 100));
    first.link.stop();

    // 守护进程不在的时候 dsh 照样往外写：运行器存着
    const second = daemon();
    await until(() => second.link.connected, "重连");
    expect(second.welcomes[0]?.welcome.running).toBe(true);
    second.link.send({ op: "send", line: "二" });
    await until(() => rpc(second.entries).length === 1, "回显");
    // 第一次处理过的（started、"一" 的回显）不再补发
    expect(rpc(second.entries)).toEqual([{ echo: "二" }]);
    expect(second.entries.some((e) => e.type === "started")).toBe(false);
  });

  it("连接中途断了自动重连：补发断开期间的，不重复", async () => {
    const { daemon, until, startFake } = await setup();
    // 处理得慢：断开时手上还有没确认的
    const { link, entries } = daemon(30);
    await until(() => link.connected, "连上");
    startFake(link);
    for (let i = 0; i < 20; i++) link.send({ op: "send", line: `行${i}` });
    await until(() => rpc(entries).length >= 3, "开始回显");
    // 把 docker exec 那一截弄断再连上（同一个守护进程，记着处理到哪了）
    link.stop();
    link.start();
    await until(() => rpc(entries).length === 20, "全部回显");
    expect(rpc(entries).map((e) => e.echo)).toEqual(Array.from({ length: 20 }, (_, i) => `行${i}`));
  });

  it("停 dsh：它起的子进程一起停", async () => {
    const { daemon, until, startFake } = await setup();
    const { link, entries } = daemon();
    await until(() => link.connected, "连上");
    startFake(link);
    link.send({ op: "send", line: "spawn-child" });
    await until(() => rpc(entries).some((e) => e.child), "子进程");
    const childPid = rpc(entries).find((e) => e.child)?.child as number;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(childPid)).toBe(true);
    link.send({ op: "stop", graceMs: 500 });
    await until(() => entries.some((e) => e.type === "exit"), "退出");
    await until(() => !alive(childPid), "子进程退出");
  });

  it("已经有一个运行器在跑：再起一个直接退出，连着的守护进程不受影响", async () => {
    const { daemon, until, serve, startFake } = await setup();
    const { link, entries } = daemon();
    await until(() => link.connected, "连上");
    const second = serve();
    const code = await new Promise<number | null>((resolve) =>
      second.on("exit", (c) => resolve(c)),
    );
    expect(code).toBe(0);
    startFake(link);
    link.send({ op: "send", line: "还连着" });
    await until(() => rpc(entries).length === 1, "回显");
  });

  it("dsh 起不来（程序不存在）：报错误条目", async () => {
    const { daemon, until } = await setup();
    const { link, entries } = daemon();
    await until(() => link.connected, "连上");
    link.send({ op: "start", args: ["/no/such/dsh"] });
    await until(() => entries.some((e) => e.type === "error" || e.type === "exit"), "错误");
    expect(entries.some((e) => e.type === "error")).toBe(true);
  });
});
