import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanGitEnv } from "./testing/fake-github";

const HOOKS = resolve(__dirname, "../sandbox/git-hooks");
const TRAILER = "Generated-by: SeekCloud (AI)";

/** 一个按沙箱的方式配好钩子的仓库。 */
function sandboxRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hooks-"));
  // 宿主机写"提交尾注"开关的那个文件。放在仓库外面，一开始不存在（按开着处理）。
  const switchFile = join(mkdtempSync(join(tmpdir(), "hooks-switch-")), "commit-trailer");
  const env = cleanGitEnv(dir, {
    // 和沙箱里一样（sandbox/provision.ts 的 sandboxGitEnv）
    GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${HOOKS}'`,
    GIT_EDITOR: "true",
    SEEKCLOUD_COMMIT_TRAILER_FILE: switchFile,
  });
  const run = (...args: string[]) => spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
  const message = (rev = "HEAD") => git("log", "-1", "--format=%B", rev).trimEnd();
  const hook = (path: string, body: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, path), 0o755);
  };
  const commit = (file: string, ...args: string[]) => {
    writeFileSync(join(dir, file), `${Math.random()}\n`);
    git("add", file);
    return run("commit", "-q", ...args);
  };
  /** 宿主机写开关：传 null 删掉文件。 */
  const trailerSwitch = (content: string | null) => {
    if (content === null) rmSync(switchFile, { force: true, recursive: true });
    else writeFileSync(switchFile, content);
  };
  git("init", "-q", "-b", "main");
  return { dir, git, run, message, hook, commit, trailerSwitch, switchFile };
}

describe("沙箱的 git 钩子", () => {
  it("提交说明末尾加上 AI 生成的尾注，改说明、跳过检查也加，不重复", () => {
    const r = sandboxRepo();
    r.commit("a", "-m", "加上 a");
    expect(r.message()).toBe(`加上 a\n\n${TRAILER}`);

    r.git("commit", "-q", "--amend", "-m", "加上 a 文件");
    expect(r.message()).toBe(`加上 a 文件\n\n${TRAILER}`);
    r.git("commit", "-q", "--amend", "--no-edit");
    expect(r.message()).toBe(`加上 a 文件\n\n${TRAILER}`);

    r.commit("b", "--no-verify", "-m", "加上 b");
    expect(r.message()).toBe(`加上 b\n\n${TRAILER}`);

    // 已有的尾注留着，接在后面
    r.commit("c", "-m", "加上 c\n\nSigned-off-by: 测试 <test@example.com>");
    expect(r.message()).toBe(`加上 c\n\nSigned-off-by: 测试 <test@example.com>\n${TRAILER}`);
  });

  it("管理员关掉“提交尾注”以后不加，已有的尾注不删；运行中改开关，下一个提交就照新的来", () => {
    const r = sandboxRepo();
    r.commit("a", "-m", "开着时的提交");
    expect(r.message()).toBe(`开着时的提交\n\n${TRAILER}`);

    r.trailerSwitch("off\n");
    r.commit("b", "-m", "关着时的提交");
    expect(r.message()).toBe("关着时的提交");
    r.commit("c", "--no-verify", "-m", "跳过检查也不加");
    expect(r.message()).toBe("跳过检查也不加");
    // 改之前那个带尾注的提交：尾注留着
    r.git("reset", "-q", "--hard", "HEAD~2");
    r.git("commit", "-q", "--amend", "--no-edit");
    expect(r.message()).toBe(`开着时的提交\n\n${TRAILER}`);

    r.trailerSwitch("on\n");
    r.commit("d", "-m", "又开了");
    expect(r.message()).toBe(`又开了\n\n${TRAILER}`);
  });

  it("关着时压缩提交，各自的尾注原样留着", () => {
    const r = sandboxRepo();
    r.commit("base", "-m", "base");
    r.commit("a", "-m", "a");
    r.commit("b", "-m", "b");
    r.trailerSwitch("off");
    r.git("-c", "sequence.editor=sed -i 2s/^pick/squash/", "rebase", "-q", "-i", "HEAD~2");
    expect(r.message()).toBe(`a\n\n${TRAILER}\n\nb\n\n${TRAILER}`);
  });

  it("开关文件不在、读不懂、不是普通文件时，都按开着处理", () => {
    const r = sandboxRepo();
    for (const content of [null, "", "maybe", "OFF?", "关"]) {
      r.trailerSwitch(content);
      r.commit(`f${content}`, "-m", "提交");
      expect(r.message(), String(content)).toBe(`提交\n\n${TRAILER}`);
    }
    r.trailerSwitch(null);
    mkdirSync(r.switchFile);
    r.commit("dir", "-m", "提交");
    expect(r.message()).toBe(`提交\n\n${TRAILER}`);
  });

  it("合并、拣选、撤销、压缩出来的提交也加", () => {
    const r = sandboxRepo();
    r.commit("a", "-m", "a");
    r.git("checkout", "-q", "-b", "side");
    r.commit("b", "-m", "b");
    r.git("checkout", "-q", "-b", "pick", "main");
    r.commit("p", "-m", "p");
    r.git("checkout", "-q", "main");

    r.git("cherry-pick", "pick");
    expect(r.message()).toBe(`p\n\n${TRAILER}`);

    r.git("merge", "-q", "--no-ff", "side", "-m", "合并 side");
    expect(r.message()).toBe(`合并 side\n\n${TRAILER}`);

    r.git("revert", "--no-edit", "HEAD~1");
    expect(r.message()).toMatch(
      /^Revert "p"\n\nThis reverts commit \w+\.\n\nGenerated-by: SeekCloud \(AI\)$/,
    );

    r.commit("c", "-m", "c");
    r.commit("d", "-m", "d");
    r.git("-c", "sequence.editor=sed -i 2s/^pick/squash/", "rebase", "-q", "-i", "HEAD~2");
    expect(r.message()).toBe(`c\n\nd\n\n${TRAILER}`);
  });

  it("建仓库、克隆照常（这时 git 也会调钩子，但还认不出仓库）", () => {
    const r = sandboxRepo();
    r.commit("a", "-m", "a");
    r.git("clone", "-q", r.dir, join(r.dir, "copy"));
    expect(r.git("-C", join(r.dir, "copy"), "log", "-1", "--format=%s").trim()).toBe("a");
  });

  it("什么都没写的提交照样中止", () => {
    const r = sandboxRepo();
    const result = r.commit("a");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("empty commit message");
  });

  it("仓库自己的钩子照常跑：.git/hooks 里的和 core.hooksPath 指的（比如 husky）", () => {
    const r = sandboxRepo();
    r.hook(".git/hooks/pre-commit", 'echo pre-commit >> "$(git rev-parse --git-dir)/ran"');
    r.commit("a", "-m", "a");
    expect(readFileSync(join(r.dir, ".git/ran"), "utf8")).toBe("pre-commit\n");

    r.hook(
      ".husky/_/commit-msg",
      'grep -q "^feat" "$1" || { echo "说明要以 feat 开头" >&2; exit 1; }',
    );
    r.git("config", "core.hooksPath", ".husky/_");
    const rejected = r.commit("b", "-m", "随便写写");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("说明要以 feat 开头");

    expect(r.commit("b", "-m", "feat: b").status).toBe(0);
    expect(r.message()).toBe(`feat: b\n\n${TRAILER}`);
  });
});
