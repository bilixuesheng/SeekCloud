import { execFile } from "node:child_process";

export interface CommandResult {
  /** 退出码；超时被杀、被信号杀掉时为 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  /** 写进标准输入；不给时标准输入是空的。 */
  input?: string;
  timeoutMs?: number;
}

/**
 * 跑一个程序。参数一律是数组，不经过 shell（#18 评论第 3 条）：仓库名、分支名、路径、环境变量的值
 * 原样作为一个参数传过去，`$(...)`、空格、引号都不会被解释。
 */
export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<CommandResult>;

/** 输出最多收这么多，再多就当失败（防止一个命令把守护进程的内存撑满）。 */
const MAX_OUTPUT = 32 * 1024 * 1024;

export const runProgram: Runner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr, timedOut: false });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        // 程序没跑起来（没装、没权限）、输出太长：这是调用方要知道的错误，不是命令的结果。
        if (typeof e.code === "string") return reject(error);
        resolve({
          code: typeof e.code === "number" ? e.code : null,
          stdout,
          stderr,
          timedOut: Boolean(e.killed) && options.timeoutMs !== undefined,
        });
      },
    );
    child.stdin?.on("error", () => {
      // 程序不读标准输入就退出了：不算错
    });
    child.stdin?.end(options.input ?? "");
  });

/** docker 命令出错。message 里有 docker 的原始输出，只写进宿主机的日志，不发给主站（ADR 0007）。 */
export class DockerError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: CommandResult,
  ) {
    super(
      `docker ${args.slice(0, 2).join(" ")} 失败（${result.timedOut ? "超时" : `退出码 ${result.code}`}）：${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

/** 调 docker 命令行。测试里可以换成别的 docker（比如换一个 DOCKER_HOST）。 */
export class Docker {
  constructor(
    readonly run: Runner = runProgram,
    readonly bin = "docker",
  ) {}

  /** 跑一个 docker 命令，返回原始结果，不管成没成功。 */
  raw(args: readonly string[], options?: RunOptions): Promise<CommandResult> {
    return this.run(this.bin, args, options);
  }

  /** 镜像不在本机才拉（Docker Hub 对不登录的拉取有次数限制）。 */
  async ensureImage(image: string): Promise<void> {
    if ((await this.raw(["image", "inspect", "--format", "{{.Id}}", image])).code === 0) return;
    await this.ok(["pull", "--quiet", image]);
  }

  /** 跑一个 docker 命令，不成功就抛 DockerError。返回标准输出。 */
  async ok(args: readonly string[], options?: RunOptions): Promise<string> {
    const result = await this.raw(args, options);
    if (result.code !== 0) throw new DockerError(args, result);
    return result.stdout;
  }
}

/** docker 说"没有这个容器/网络"。 */
export const isNotFound = (result: CommandResult) =>
  result.code !== 0 && /no such (container|object|network)|not found/i.test(result.stderr);
