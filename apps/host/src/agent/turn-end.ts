import {
  type FileChange,
  MAX_DIFF_BYTES,
  MAX_FILE_PATCH_BYTES,
  MAX_LISTED_FILES,
  type RepoDiff,
  type RepoOutcome,
  type SessionRepo,
} from "@seekcloud/protocol";
import { type SandboxGit, sandboxGitEnv, workspaceDirs } from "../sandbox/provision";
import type { ExecResult } from "../sandbox/sandboxes";

/**
 * 回合结束时整理工作区（#27）：Agent 没提交的改动由平台补提交，推送每个仓库的会话分支，
 * 算出这一回合改了哪些文件（改动卡片）。回合停止、失败时照样做，免得改动丢了。
 *
 * - 补提交的说明是"SeekCloud：保存第 N 回合未提交的改动"，作者是会话的提交身份（/etc/gitconfig），
 *   用宿主机签名；AI 尾注由沙箱里的 git 钩子加。跳过仓库自己的 pre-commit 这类检查（--no-verify）：
 *   检查没过也不能把改动丢了，Agent 下一回合自己修。
 * - 只推会话分支（refs/heads/<会话分支>），不推 Agent 切到的别的分支；不强推：远端有本地没有的提交时
 *   推送失败，跟进回合交给 Agent 处理。
 * - 工作区不在会话分支上（Agent 切走了）：不补提交，这个仓库算推送失败，原因写清楚。
 * - 只读挂载的仓库不推送。
 */

/** 在沙箱里跑一个命令（Sandboxes.exec）。 */
export type SandboxExec = (
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<ExecResult>;

const ERROR_TAIL = 2000;

const tail = (r: ExecResult) => (r.stderr || r.stdout).trim().slice(-ERROR_TAIL);

/** 回合开始时每个仓库会话分支的提交（算这一回合改了哪些文件用）。拿不到的（分支还没有）不记。 */
export async function turnStart(
  exec: SandboxExec,
  repos: readonly SessionRepo[],
): Promise<Map<string, string>> {
  const dirs = workspaceDirs(repos);
  const starts = new Map<string, string>();
  for (const [i, repo] of repos.entries()) {
    const r = await exec(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${repo.branch}`], {
      cwd: dirs[i],
      timeoutMs: 30_000,
    });
    const sha = r.stdout.trim();
    if (r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha)) starts.set(repo.fullName, sha);
  }
  return starts;
}

/** git diff --numstat -z 的输出：改名的是"增\t删\t\0原路径\0新路径\0"，别的是"增\t删\t路径\0"。 */
export function parseNumstat(out: string): FileChange[] {
  const parts = out.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i];
    if (!head) continue;
    const [added = "", deleted = "", path = ""] = head.split("\t");
    const binary = added === "-" && deleted === "-";
    const counts = {
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      ...(binary && { binary: true }),
    };
    if (path === "") {
      // 改名：后面两段是原路径和新路径
      const from = parts[i + 1] ?? "";
      const to = parts[i + 2] ?? "";
      i += 2;
      files.push({ path: to, from, ...counts });
    } else {
      files.push({ path, ...counts });
    }
  }
  return files;
}

export async function finishTurn(
  exec: SandboxExec,
  git: SandboxGit,
  input: {
    repos: readonly SessionRepo[];
    starts: ReadonlyMap<string, string>;
    turnNumber?: number;
  },
): Promise<RepoOutcome[]> {
  const env = sandboxGitEnv(git);
  const dirs = workspaceDirs(input.repos);
  const outcomes: RepoOutcome[] = [];
  for (const [i, repo] of input.repos.entries()) {
    const cwd = dirs[i] as string;
    const run = (argv: string[], timeoutMs = 60_000) => exec(argv, { cwd, env, timeoutMs });

    const branch = (await run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    let savedCommit: string | undefined;
    let problem: string | undefined;
    if (branch !== repo.branch) {
      problem = `工作区不在会话分支 ${repo.branch} 上（现在在 ${branch || "分离的 HEAD"}），没有补提交未提交的改动。请切回 ${repo.branch} 再提交。`;
    } else if ((await run(["git", "status", "--porcelain"])).stdout.trim() !== "") {
      const message = input.turnNumber
        ? `SeekCloud：保存第 ${input.turnNumber} 回合未提交的改动`
        : "SeekCloud：保存这一回合未提交的改动";
      const added = await run(["git", "add", "--all"], 5 * 60_000);
      const committed =
        added.exitCode === 0
          ? await run(["git", "commit", "--quiet", "--no-verify", "-m", message], 5 * 60_000)
          : added;
      if (committed.exitCode === 0) {
        savedCommit = (await run(["git", "rev-parse", "HEAD"])).stdout.trim();
      } else {
        problem = `补提交未提交的改动失败：${tail(committed)}`;
      }
    }

    const head = (
      await run(["git", "rev-parse", "--verify", `refs/heads/${repo.branch}`])
    ).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(head)) {
      outcomes.push({
        fullName: repo.fullName,
        head: "0".repeat(40),
        push: "failed",
        error: problem ?? `找不到会话分支 ${repo.branch}`,
        files: [],
      });
      continue;
    }

    // 这一回合改了的文件：回合开始时的提交到现在
    const start = input.starts.get(repo.fullName);
    let files: FileChange[] = [];
    let omittedFiles: number | undefined;
    if (start && start !== head) {
      const diff = await run(["git", "diff", "--numstat", "-z", "-M", start, head], 5 * 60_000);
      if (diff.exitCode === 0) {
        const all = parseNumstat(diff.stdout);
        files = all.slice(0, MAX_LISTED_FILES);
        if (all.length > MAX_LISTED_FILES) omittedFiles = all.length - MAX_LISTED_FILES;
      }
    }

    let push: RepoOutcome["push"] = "read_only";
    let error = problem;
    if (repo.access === "push") {
      const pushed = await run(
        ["git", "push", "--quiet", "origin", `refs/heads/${repo.branch}:refs/heads/${repo.branch}`],
        10 * 60_000,
      );
      if (pushed.exitCode === 0 && !problem) push = "pushed";
      else {
        push = "failed";
        if (pushed.exitCode !== 0) {
          error = [problem, `推送 ${repo.branch} 失败：${tail(pushed)}`].filter(Boolean).join("\n");
        }
      }
    }
    outcomes.push({
      fullName: repo.fullName,
      head,
      ...(savedCommit && { savedCommit }),
      push,
      ...(error && { error: error.slice(-ERROR_TAIL * 2) }),
      files,
      ...(omittedFiles !== undefined && { omittedFiles }),
    });
  }
  return outcomes;
}

/** git diff 的原文按文件切开（每段以 "diff --git " 开头）。 */
export function splitPatch(patch: string): string[] {
  if (!patch.startsWith("diff --git ")) return [];
  return patch
    .split(/\n(?=diff --git )/)
    .map((chunk) => (chunk.endsWith("\n") ? chunk : `${chunk}\n`));
}

/**
 * 会话分支对比基础分支的改动（改动面板，#27）：从会话分支和基础分支分开的地方算起，所以基础分支后来的提交不算进来。
 * 单个文件太大的不带 patch，整个仓库的 patch 最多 MAX_DIFF_BYTES。
 */
export async function branchDiffs(
  exec: SandboxExec,
  repos: readonly SessionRepo[],
): Promise<RepoDiff[]> {
  const dirs = workspaceDirs(repos);
  const diffs: RepoDiff[] = [];
  for (const [i, repo] of repos.entries()) {
    const cwd = dirs[i] as string;
    const run = (argv: string[], timeoutMs = 60_000) => exec(argv, { cwd, timeoutMs });
    const head = (
      await run(["git", "rev-parse", "--verify", `refs/heads/${repo.branch}`])
    ).stdout.trim();
    const upstream = `refs/remotes/origin/${repo.baseBranch}`;
    const forked = await run(["git", "merge-base", upstream, head]);
    const base =
      forked.exitCode === 0
        ? forked.stdout.trim()
        : (await run(["git", "rev-parse", "--verify", upstream])).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(head) || !/^[0-9a-f]{40,64}$/.test(base)) continue;

    const numstat = await run(["git", "diff", "--numstat", "-z", "-M", base, head], 5 * 60_000);
    const all = numstat.exitCode === 0 ? parseNumstat(numstat.stdout) : [];
    const listed = all.slice(0, MAX_LISTED_FILES);
    // 原文最多读 4 倍的上限（读多了也用不上），后面的当作太大
    const raw = await run(
      [
        "sh",
        "-c",
        'git diff -M --no-color --no-ext-diff "$1" "$2" | head -c "$3"',
        "sh",
        base,
        head,
        String(MAX_DIFF_BYTES * 4),
      ],
      5 * 60_000,
    );
    const chunks = splitPatch(raw.stdout);
    // 读到上限被截断的：最后一段不完整，扔掉
    const cut = Buffer.byteLength(raw.stdout) >= MAX_DIFF_BYTES * 4;
    if (cut) chunks.pop();
    // 和 numstat 一样的顺序；对不上（很少见）就都不带 patch
    const aligned = cut ? chunks.length <= all.length : chunks.length === all.length;
    let budget = MAX_DIFF_BYTES;
    let truncated = all.length > listed.length;
    const files = listed.map((file, index) => {
      const patch = aligned ? chunks[index] : undefined;
      if (file.binary) return file;
      if (patch === undefined) {
        truncated = true;
        return file;
      }
      const size = Buffer.byteLength(patch);
      if (size > MAX_FILE_PATCH_BYTES) return { ...file, tooLarge: true };
      if (size > budget) {
        truncated = true;
        return file;
      }
      budget -= size;
      return { ...file, patch };
    });
    diffs.push({
      fullName: repo.fullName,
      baseBranch: repo.baseBranch,
      base,
      head,
      files,
      ...(truncated && { truncated: true }),
    });
  }
  return diffs;
}
