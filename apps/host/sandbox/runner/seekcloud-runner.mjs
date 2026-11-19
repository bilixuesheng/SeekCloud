#!/usr/bin/env node
// SeekCloud 的运行器（#25 的 2026-11-15 评论）：装进通用镜像，在沙箱里常驻，托管这个沙箱的 dsh 进程。
//
// 为什么要它：守护进程重启（一键更新）时，回合不能断。dsh 如果是守护进程直接起的子进程，守护进程一退它就跟着退。
// 所以 dsh 由沙箱里的运行器起，守护进程经沙箱里的本地套接字连运行器，断了能重连；
// dsh 的输出逐条编号存着，守护进程重连时说"收到第几条了"，运行器补发后面的，不丢、不重复。
//
//   seekcloud-runner serve   [--socket <路径>]          常驻（seekcloud-init 起它）；已经有一个在跑就直接退出
//   seekcloud-runner connect [--socket <路径>]          把标准输入输出接到套接字上（守护进程用 docker exec -i 跑它）
//
// 接口尽量小、尽量不改：守护进程更新时不用动它。每行一个 JSON。
//
// 守护进程 → 运行器：
//   { "op": "hello", "since": 12 }                     连上以后第一行：收到过的最大编号（没收到过写 0）
//   { "op": "start", "args": [...], "cwd": "…", "env": {…} }   起 dsh（已经在跑就不起）
//   { "op": "send", "line": "…" }                      往 dsh 的标准输入写一行（JSON-RPC）
//   { "op": "stop", "graceMs": 3000 }                  停 dsh：先 SIGTERM，到时间还没退就 SIGKILL
//   { "op": "ack", "seq": 30 }                         这个编号以前的都处理完了，运行器可以丢掉
//
// 运行器 → 守护进程：
//   { "op": "welcome", "instance": "…", "running": true, "pid": 42, "gap": false }   回 hello；gap 为真表示有一段已经丢了
//   { "seq": 13, "type": "rpc", "line": "…" }          dsh 标准输出的一行（JSON-RPC）
//   { "seq": 14, "type": "live", "line": "…" }         dsh 第 4 个文件描述符的一行（live-output.js 写的增量和 token 数）
//   { "seq": 15, "type": "stderr", "text": "…" }       dsh 标准错误的一行（宿主机只记日志）
//   { "seq": 16, "type": "started", "pid": 42 }        dsh 起来了（沙箱里的进程号）
//   { "seq": 17, "type": "exit", "code": 0, "signal": null }   dsh 退出了
//   { "seq": 18, "type": "error", "text": "…" }        运行器自己出的错（起不来、写不进去）
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_SOCKET = "/run/seekcloud/runner.sock";
/** 没确认的条目最多存这么多；再多就从最旧的丢（重连时告诉守护进程有一段丢了）。 */
const MAX_ENTRIES = 50_000;
const MAX_TEXT = 64 * 1024;

const args = process.argv.slice(2);
const command = args[0];
const socketPath = option("--socket") ?? process.env.SEEKCLOUD_RUNNER_SOCKET ?? DEFAULT_SOCKET;

function option(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * 按行读一个流。读的时候出的错（对面没读完就断了，收到 ECONNRESET 这类）readline 会再抛一次：
 * 没人接就是整个运行器退出，连带 dsh 一起停。流自己的 close 照常处理断开，这里只把错吞掉。
 */
function lines(input) {
  const reader = createInterface({ input });
  reader.on("error", () => {});
  return reader;
}

if (command === "serve") await serve();
else if (command === "connect") bridge();
else {
  process.stderr.write("用法：seekcloud-runner serve|connect [--socket <路径>]\n");
  process.exit(2);
}

/** 把标准输入输出接到运行器的套接字上。套接字断了就退出（守护进程会重新 docker exec 一个）。 */
function bridge() {
  const socket = connect(socketPath);
  socket.on("error", (error) => {
    process.stderr.write(`连不上运行器：${error.message}\n`);
    process.exit(1);
  });
  socket.on("connect", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.on("close", () => process.exit(0));
  process.stdin.on("end", () => socket.end());
}

async function serve() {
  if (await alive(socketPath)) {
    // 已经有一个运行器在跑：不起第二个
    process.exit(0);
  }
  try {
    unlinkSync(socketPath);
  } catch {
    // 没有旧的套接字文件
  }
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

  const instance = randomUUID();
  /** 还没确认的条目，按编号从小到大。 */
  const entries = [];
  let nextSeq = 1;
  let dropped = 0;
  /** 现在连着的守护进程（只认最后连上的那个）。 */
  let client;
  /** dsh 进程。 */
  let child;

  const emit = (entry) => {
    const full = { seq: nextSeq++, ...entry };
    entries.push(full);
    if (entries.length > MAX_ENTRIES) {
      entries.shift();
      dropped = full.seq - entries.length;
    }
    client?.write(`${JSON.stringify(full)}\n`);
  };
  const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

  const start = (op) => {
    if (child) return;
    if (
      !Array.isArray(op.args) ||
      op.args.length === 0 ||
      !op.args.every((a) => typeof a === "string")
    ) {
      emit({ type: "error", text: "start 的 args 要是非空的字符串数组" });
      return;
    }
    let proc;
    try {
      proc = spawn(op.args[0], op.args.slice(1), {
        cwd: typeof op.cwd === "string" ? op.cwd : undefined,
        env: { ...process.env, ...(op.env ?? {}), SEEKCLOUD_LIVE_FD: "3" },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        // 自己一个进程组：停的时候连它起的子进程一起停
        detached: true,
      });
    } catch (error) {
      emit({ type: "error", text: `dsh 起不来：${error.message}` });
      return;
    }
    child = proc;
    proc.on("error", (error) => emit({ type: "error", text: `dsh 起不来：${error.message}` }));
    proc.stdin.on("error", () => {});
    if (proc.pid !== undefined) emit({ type: "started", pid: proc.pid });
    lines(proc.stdout).on("line", (line) => emit({ type: "rpc", line }));
    lines(proc.stdio[3]).on("line", (line) => emit({ type: "live", line }));
    lines(proc.stderr).on("line", (line) => emit({ type: "stderr", text: clip(line) }));
    proc.on("exit", (code, signal) => {
      if (child === proc) child = undefined;
      emit({ type: "exit", code, signal });
    });
  };

  const stop = (op) => {
    const proc = child;
    if (!proc?.pid) return;
    const group = -proc.pid;
    try {
      process.kill(group, "SIGTERM");
    } catch {
      // 已经退了
    }
    const graceMs = Number.isFinite(op.graceMs) ? Math.max(0, op.graceMs) : 3000;
    const timer = setTimeout(() => {
      try {
        process.kill(group, "SIGKILL");
      } catch {
        // 已经退了
      }
    }, graceMs);
    timer.unref();
    proc.once("exit", () => clearTimeout(timer));
  };

  const handle = (socket, op) => {
    switch (op.op) {
      case "hello": {
        const since = Number.isInteger(op.since) && op.since >= 0 ? op.since : 0;
        const oldest = entries[0]?.seq ?? nextSeq;
        socket.write(
          `${JSON.stringify({
            op: "welcome",
            instance,
            running: child !== undefined,
            pid: child?.pid ?? null,
            // 要补发的第一条已经被丢掉了
            gap: dropped > 0 && since + 1 < oldest,
          })}\n`,
        );
        for (const entry of entries)
          if (entry.seq > since) socket.write(`${JSON.stringify(entry)}\n`);
        return;
      }
      case "ack":
        if (Number.isInteger(op.seq)) {
          while (entries.length > 0 && entries[0].seq <= op.seq) entries.shift();
        }
        return;
      case "start":
        return start(op);
      case "send":
        if (!child || typeof op.line !== "string") {
          emit({ type: "error", text: "dsh 没有在跑，这一行没有送出去" });
          return;
        }
        child.stdin.write(op.line.endsWith("\n") ? op.line : `${op.line}\n`);
        return;
      case "stop":
        return stop(op);
      default:
        emit({ type: "error", text: `不认识的操作 ${String(op.op)}` });
    }
  };

  const server = createServer((socket) => {
    socket.on("error", () => {});
    let greeted = false;
    lines(socket).on("line", (line) => {
      let op;
      try {
        op = JSON.parse(line);
      } catch {
        return;
      }
      if (!greeted) {
        if (op.op !== "hello") return;
        greeted = true;
        // 后连上的顶掉先连上的（守护进程重启、断线重连）。只看打了招呼的：探活的连接不算
        if (client && client !== socket) client.destroy();
        client = socket;
        handle(socket, op);
        return;
      }
      handle(socket, op);
    });
    socket.on("close", () => {
      if (client === socket) client = undefined;
    });
  });
  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // 测试里的临时目录可能不让改：不要紧
    }
  });
  const shutdown = () => {
    stop({ graceMs: 2000 });
    server.close();
    setTimeout(() => process.exit(0), 2500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/** 这个套接字上有没有活着的运行器。 */
function alive(path) {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
