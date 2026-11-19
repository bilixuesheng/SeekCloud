import { randomInt } from "node:crypto";
import type { Runner } from "./docker";

/**
 * 沙箱的磁盘额度（#168，ADR 0005）。照 Claude Code 网页版：每个沙箱一份固定的额度，用完了写文件报
 * "No space left on device"，删了马上又能写。
 *
 * 做法是 XFS 的项目配额：宿主机上 Docker（包括 containerd）、Sysbox 和这里的沙箱目录都放在一个开了
 * prjquota 的 XFS 上（scripts/test-machine.sh 建）。每个沙箱分一个项目编号，下面两块设成这个项目，共用一个上限：
 *
 * - 沙箱的可写层：容器根目录 overlay 的 upperdir 和 workdir（两个都设：XFS 不让跨项目 rename，
 *   只设 upperdir 时 overlay 往上层拷文件会失败）。从容器第一个进程的 mountinfo 读，不管 Docker 用的是
 *   overlay2 还是 containerd 的快照；
 * - 沙箱里的 /var/lib/docker：不用 Sysbox 自动给的那块（不在容器的配额里），挂宿主机上这个沙箱自己的目录。
 *
 * 存储不是 XFS、没开 prjquota、没装 xfsprogs 时不限（照旧靠宿主机磁盘超过 80% 时回收兜着），
 * 沙箱自己的 /var/lib/docker 目录照样用。
 */

export const QUOTA_PROJECT_LABEL = "cn.seekcloud.quota-project";

export interface SandboxStorage {
  /** 宿主机上每个沙箱一个目录：<dir>/<会话 ID>/docker 挂到沙箱的 /var/lib/docker。 */
  dir: string;
  /** 每个沙箱的磁盘上限，GB。 */
  limitGb: number;
}

export type QuotaSupport = { ok: true; mount: string } | { ok: false; reason: string };

/** 项目编号的范围：避开 Docker 自己的配额从 1 开始数的那些。 */
const PROJECT_MIN = 100_000;
const PROJECT_MAX = 2 ** 31 - 1;
/** 进 xfs_quota 的 -c 命令行的路径：它自己按空格切，路径里不能有空白和引号。 */
const SAFE_PATH = /^\/[A-Za-z0-9_./:@+-]*$/;

/** mountinfo 里的路径把空格这些写成 \040：还原。 */
const decodeMountPath = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));

/** 容器第一个进程的 mountinfo 里，根目录那个 overlay 的 upperdir 和 workdir（宿主机上的路径）。 */
export function overlayDirs(mountinfo: string): { upper: string; work: string } | undefined {
  let found: { upper: string; work: string } | undefined;
  for (const line of mountinfo.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!left || !right) continue;
    const mountPoint = left.split(" ")[4];
    const [fsType, , superOptions = ""] = right.split(" ");
    if (mountPoint !== "/" || fsType !== "overlay") continue;
    const options = new Map(
      superOptions.split(",").map((o) => {
        const at = o.indexOf("=");
        return at < 0 ? [o, ""] : [o.slice(0, at), decodeMountPath(o.slice(at + 1))];
      }),
    );
    const upper = options.get("upperdir");
    const work = options.get("workdir");
    // 叠了几层的取最上面的（排在最后）
    if (upper && work) found = { upper, work };
  }
  return found;
}

const SUPPORT_SCRIPT = [
  'd=$1; mkdir -p "$d"',
  't=$(stat -f -c %T "$d")',
  '[ "$t" = xfs ] || { echo "沙箱目录 $d 不在 XFS 上（是 $t）"; exit 2; }',
  'm=$(stat -c %m "$d")',
  'command -v xfs_quota >/dev/null && command -v xfs_io >/dev/null || { echo "没有装 xfsprogs"; exit 2; }',
  'xfs_quota -x -c "state -p" "$m" 2>/dev/null | grep -q "Enforcement: ON" || { echo "$m 没有开项目配额（挂载时加 prjquota）"; exit 2; }',
  'echo "$m"',
].join("\n");

const APPLY_SCRIPT = [
  "set -eu",
  // limit 带着单位，比如 30g
  "m=$1; id=$2; limit=$3; shift 3",
  'dev=$(stat -c %d "$m")',
  'for d in "$@"; do',
  '  [ "$(stat -c %d "$d")" = "$dev" ] || { echo "$d 和沙箱目录不在同一个文件系统上" >&2; exit 3; }',
  // 已经是这个项目的（休眠后唤醒）不再整棵树重设一遍
  "  cur=$(xfs_io -c lsproj \"$d\" | awk '{ print $3 }')",
  '  [ "$cur" = "$id" ] || xfs_quota -x -c "project -s -p $d $id" "$m" >/dev/null',
  "done",
  'xfs_quota -x -c "limit -p bhard=$limit $id" "$m"',
].join("\n");

export class DiskQuota {
  readonly #storage: SandboxStorage;
  readonly #root: Runner;
  #support: Promise<QuotaSupport> | undefined;

  constructor(storage: SandboxStorage, root: Runner) {
    if (!SAFE_PATH.test(storage.dir)) throw new Error(`沙箱目录的路径不对：${storage.dir}`);
    if (!Number.isInteger(storage.limitGb) || storage.limitGb <= 0) {
      throw new Error("沙箱的磁盘上限要是正整数（GB）");
    }
    this.#storage = storage;
    this.#root = root;
  }

  get limitGb(): number {
    return this.#storage.limitGb;
  }

  /** 这个沙箱在宿主机上的目录（会话 ID 已经由 Sandboxes 核对过是 UUID）。 */
  sandboxDir(sessionId: string): string {
    return `${this.#storage.dir}/${sessionId}`;
  }

  /** 挂到沙箱 /var/lib/docker 的目录。 */
  dockerDir(sessionId: string): string {
    return `${this.sandboxDir(sessionId)}/docker`;
  }

  /** 宿主机的存储能不能限：结果记下来（换存储要重启守护进程）。 */
  support(): Promise<QuotaSupport> {
    this.#support ??= this.#root("sh", ["-c", SUPPORT_SCRIPT, "sh", this.#storage.dir], {
      timeoutMs: 30_000,
    }).then((r): QuotaSupport => {
      const out = r.stdout.trim();
      if (r.code === 0 && out.startsWith("/")) return { ok: true, mount: out };
      return { ok: false, reason: out || r.stderr.trim() || `检查失败（退出码 ${r.code}）` };
    });
    return this.#support;
  }

  /** 建沙箱之前：建好它的目录，挑一个项目编号（目录已经有编号的沿用，比如容器被删了又建）。 */
  async prepare(sessionId: string, taken: ReadonlySet<number>): Promise<number> {
    const dir = this.dockerDir(sessionId);
    const made = await this.#root(
      "sh",
      ["-c", 'mkdir -p "$1" && (xfs_io -c lsproj "$1" 2>/dev/null || true)', "sh", dir],
      { timeoutMs: 30_000 },
    );
    if (made.code !== 0) throw new Error(`建不了沙箱目录 ${dir}：${made.stderr.trim()}`);
    const existing = Number(/projid = (\d+)/.exec(made.stdout)?.[1] ?? 0);
    if (existing >= PROJECT_MIN && !taken.has(existing)) return existing;
    for (;;) {
      const id = randomInt(PROJECT_MIN, PROJECT_MAX);
      if (!taken.has(id)) return id;
    }
  }

  /**
   * 沙箱开着以后：可写层（从容器第一个进程的 mountinfo 读）和沙箱自己的 /var/lib/docker 设成这个项目，
   * 设上限。存储不支持时什么也不做，返回 false。
   */
  async apply(sessionId: string, projectId: number, initPid: number): Promise<boolean> {
    const support = await this.support();
    if (!support.ok) return false;
    const info = await this.#root("cat", [`/proc/${initPid}/mountinfo`], { timeoutMs: 30_000 });
    const overlay = info.code === 0 ? overlayDirs(info.stdout) : undefined;
    if (!overlay) throw new Error(`读不到沙箱根目录的 overlay（进程 ${initPid}）`);
    const dirs = [overlay.upper, overlay.work, this.dockerDir(sessionId)];
    for (const d of dirs)
      if (!SAFE_PATH.test(d)) throw new Error(`路径里有 xfs_quota 认不了的字符：${d}`);
    const result = await this.#root(
      "sh",
      [
        "-c",
        APPLY_SCRIPT,
        "sh",
        support.mount,
        String(projectId),
        `${this.#storage.limitGb}g`,
        ...dirs,
      ],
      { timeoutMs: 10 * 60_000 },
    );
    if (result.code !== 0) {
      throw new Error(`设不了沙箱的磁盘上限：${(result.stderr || result.stdout).trim()}`);
    }
    return true;
  }

  /** 删沙箱以后：删掉它的目录，撤掉它的上限。 */
  async release(sessionId: string, projectId: number | undefined): Promise<void> {
    const removed = await this.#root("rm", ["-rf", "--", this.sandboxDir(sessionId)], {
      timeoutMs: 10 * 60_000,
    });
    if (removed.code !== 0) {
      throw new Error(`删不了沙箱目录 ${this.sandboxDir(sessionId)}：${removed.stderr.trim()}`);
    }
    const support = await this.support();
    if (support.ok && projectId !== undefined) {
      await this.#root("xfs_quota", ["-x", "-c", `limit -p bhard=0 ${projectId}`, support.mount], {
        timeoutMs: 30_000,
      });
    }
  }
}

/** 标签里记的项目编号。 */
export function projectOf(labels: Record<string, string> | null | undefined): number | undefined {
  const value = Number(labels?.[QUOTA_PROJECT_LABEL]);
  return Number.isInteger(value) && value >= PROJECT_MIN ? value : undefined;
}
