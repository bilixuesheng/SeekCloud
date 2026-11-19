import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiskQuota, overlayDirs, projectOf, QUOTA_PROJECT_LABEL } from "./disk-quota";
import { type CommandResult, type Runner, runProgram } from "./docker";

const SESSION = "0b6c8f3e-1d2a-4c5b-9e8f-7a6b5c4d3e2f";

/** overlay2 的根目录（Docker 自己的存储）和 containerd 快照的根目录各一行，夹在别的挂载中间。 */
const MOUNTINFO = [
  "1201 1100 0:52 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/AB:/var/lib/docker/overlay2/l/CD,upperdir=/var/lib/docker/overlay2/abc/diff,workdir=/var/lib/docker/overlay2/abc/work,nouserxattr",
  "1202 1201 0:55 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
  "1203 1201 253:1 /var/lib/seekcloud/sandboxes/x/docker /var/lib/docker rw,relatime - xfs /dev/loop0 rw,prjquota",
].join("\n");

describe("沙箱的磁盘额度", () => {
  it("从 mountinfo 读出根目录 overlay 的 upperdir 和 workdir；叠了几层的取最上面的；路径里的 \\040 还原", () => {
    expect(overlayDirs(MOUNTINFO)).toEqual({
      upper: "/var/lib/docker/overlay2/abc/diff",
      work: "/var/lib/docker/overlay2/abc/work",
    });
    const containerd = [
      "10 1 0:40 / / rw - overlay overlay rw,lowerdir=/a,upperdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/7/fs,workdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/7/work",
      "11 10 0:41 / / rw,idmapped - overlay overlay rw,lowerdir=/b,upperdir=/x/y\\040z/fs,workdir=/x/y\\040z/work",
    ].join("\n");
    expect(overlayDirs(containerd)).toEqual({ upper: "/x/y z/fs", work: "/x/y z/work" });
    // 根目录不是 overlay（比如别的运行时）：读不到
    expect(overlayDirs("1 0 8:1 / / rw - ext4 /dev/sda1 rw")).toBeUndefined();
  });

  it("项目编号从容器标签读，不认的当作没有", () => {
    expect(projectOf({ [QUOTA_PROJECT_LABEL]: "123456" })).toBe(123456);
    expect(projectOf({ [QUOTA_PROJECT_LABEL]: "12" })).toBeUndefined();
    expect(projectOf({ [QUOTA_PROJECT_LABEL]: "abc" })).toBeUndefined();
    expect(projectOf(null)).toBeUndefined();
  });

  it("存储不在 XFS 上：不限，原因说清楚", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-ext4-"));
    const quota = new DiskQuota({ dir, limitGb: 30 }, runProgram);
    const support = await quota.support();
    expect(support.ok).toBe(false);
    expect(support.ok ? "" : support.reason).toContain("不在 XFS 上");
    // 不支持时 apply 什么也不做
    expect(await quota.apply(SESSION, 123_456, 1)).toBe(false);
  });

  /** 假的 stat、xfs_io、xfs_quota（这台机器的内核不一定开了配额），记下 xfs_quota 收到的命令。 */
  const fakeXfs = (projid: number) => {
    const bin = mkdtempSync(join(tmpdir(), "quota-bin-"));
    const log = join(bin, "xfs_quota.log");
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    script(
      "stat",
      'case "$*" in "-f -c %T "*) echo xfs ;; "-c %m "*) echo /srv/storage ;; "-c %d "*) echo 2049 ;; esac',
    );
    script("xfs_io", `echo "projid = ${projid}"`);
    script(
      "xfs_quota",
      `printf '%s\\n' "$*" >> ${log}; case "$*" in *"state -p"*) echo "  Enforcement: ON" ;; esac`,
    );
    const root: Runner = (file, args) =>
      file === "cat"
        ? Promise.resolve({ code: 0, stdout: MOUNTINFO, stderr: "", timedOut: false })
        : new Promise<CommandResult>((resolve) =>
            execFile(
              file,
              [...args],
              { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
              (error, stdout, stderr) =>
                resolve({
                  code: error ? ((error as { code?: number }).code ?? 1) : 0,
                  stdout,
                  stderr,
                  timedOut: false,
                }),
            ),
          );
    const calls = () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n");
      } catch {
        return [];
      }
    };
    return { root, calls };
  };

  it("XFS 开了项目配额：可写层的 upperdir、workdir 和沙箱自己的 /var/lib/docker 设成同一个项目，设上限", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-xfs-"));
    const { root, calls } = fakeXfs(0);
    const quota = new DiskQuota({ dir, limitGb: 30 }, root);
    expect(await quota.support()).toEqual({ ok: true, mount: "/srv/storage" });
    expect(await quota.apply(SESSION, 123_456, 4242)).toBe(true);
    expect(calls().filter((c) => !c.includes("state -p"))).toEqual([
      "-x -c project -s -p /var/lib/docker/overlay2/abc/diff 123456 /srv/storage",
      "-x -c project -s -p /var/lib/docker/overlay2/abc/work 123456 /srv/storage",
      `-x -c project -s -p ${dir}/${SESSION}/docker 123456 /srv/storage`,
      "-x -c limit -p bhard=30g 123456 /srv/storage",
    ]);
  });

  it("已经是这个项目的（休眠后唤醒）不再整棵树重设，只重设上限；删沙箱时撤掉上限", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-xfs-"));
    const { root, calls } = fakeXfs(123_456);
    const quota = new DiskQuota({ dir, limitGb: 8 }, root);
    await quota.apply(SESSION, 123_456, 4242);
    expect(calls().filter((c) => !c.includes("state -p"))).toEqual([
      "-x -c limit -p bhard=8g 123456 /srv/storage",
    ]);
    await quota.release(SESSION, 123_456);
    expect(calls().at(-1)).toBe("-x -c limit -p bhard=0 123456 /srv/storage");
  });

  it("挑项目编号：目录已经有编号的沿用，没有的挑一个没被占的", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-xfs-"));
    expect(
      await new DiskQuota({ dir, limitGb: 1 }, fakeXfs(234_567).root).prepare(SESSION, new Set()),
    ).toBe(234_567);
    // 沿用的编号被别的沙箱占了（目录是拷过来的）：换一个
    const fresh = await new DiskQuota({ dir, limitGb: 1 }, fakeXfs(234_567).root).prepare(
      SESSION,
      new Set([234_567]),
    );
    expect(fresh).not.toBe(234_567);
    expect(fresh).toBeGreaterThanOrEqual(100_000);
  });

  it("路径和上限不对的不收", () => {
    expect(() => new DiskQuota({ dir: "relative/dir", limitGb: 1 }, runProgram)).toThrow();
    expect(() => new DiskQuota({ dir: "/a b", limitGb: 1 }, runProgram)).toThrow();
    expect(() => new DiskQuota({ dir: "/a", limitGb: 0 }, runProgram)).toThrow();
    expect(() => new DiskQuota({ dir: "/a", limitGb: 1.5 }, runProgram)).toThrow();
  });
});
