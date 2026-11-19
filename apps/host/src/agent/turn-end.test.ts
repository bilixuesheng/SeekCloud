import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRepo } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";
import type { SandboxGit } from "../sandbox/provision";
import { cleanGitEnv } from "../testing/fake-github";
import { finishTurn, parseNumstat, type SandboxExec, turnStart } from "./turn-end";

const git: SandboxGit = {
  proxy: { host: "10.88.0.1", port: 8080 },
  caPem: "",
  signingPublicKey: "",
};
const BRANCH = "seekcloud/abc123";
/** 够长，改一行以后 git 还认得出改名。 */
const LINES = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/**
 * 一个"沙箱"：/workspace 换成临时目录，命令在本机跑。远端是本机的裸仓库（代替经 Git 代理的 GitHub）。
 */
function sandbox(names: string[]) {
  const root = mkdtempSync(join(tmpdir(), "turn-end-"));
  const home = join(root, "home");
  const env = cleanGitEnv(home);
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const repos = names.map((name) => {
    const bare = join(root, `${name}.git`);
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
    const dir = join(root, "workspace", name);
    execFileSync("git", ["clone", "-q", bare, dir], { env });
    writeFileSync(join(dir, "README.md"), `${LINES.join("\n")}\n`);
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "初始");
    sh(dir, "push", "-q", "origin", "HEAD:main");
    sh(dir, "checkout", "-q", "-b", BRANCH);
    return { name, bare, dir };
  });
  const exec: SandboxExec = async (argv, options) => {
    const cwd = options.cwd?.replace(/^\/workspace/, join(root, "workspace"));
    const r = spawnSync(argv[0] as string, argv.slice(1), {
      cwd,
      env: { ...env, ...options.env, GIT_CONFIG_PARAMETERS: "" },
      encoding: "utf8",
    });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, timedOut: false };
  };
  const session = (name: string, access: SessionRepo["access"] = "push"): SessionRepo => ({
    fullName: `acme/${name}`,
    baseBranch: "main",
    branch: BRANCH,
    access,
  });
  const remoteHead = (bare: string) =>
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], {
      cwd: bare,
      encoding: "utf8",
    }).stdout.trim();
  return { repos, exec, session, sh, remoteHead };
}

describe("回合结束时整理工作区", () => {
  it("numstat：增删行数、改名、二进制文件", () => {
    expect(
      parseNumstat("3\t1\tsrc/a.ts\0-\t-\tlogo.png\0" + "0\t0\t\0old/b.ts\0new/b.ts\0"),
    ).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "logo.png", additions: 0, deletions: 0, binary: true },
      { path: "new/b.ts", from: "old/b.ts", additions: 0, deletions: 0 },
    ]);
    expect(parseNumstat("")).toEqual([]);
  });

  it("Agent 没提交的改动由平台补提交，推送会话分支；这一回合改了的文件连同 Agent 自己的提交一起算", async () => {
    const box = sandbox(["app"]);
    const [app] = box.repos as [(typeof box.repos)[0]];
    const repos = [box.session("app")];
    const starts = await turnStart(box.exec, repos);
    // Agent 自己提交了一个，又留下一些没提交的：改了一行、加了一个文件、改了名
    writeFileSync(
      join(app.dir, "README.md"),
      `${LINES.map((l, i) => (i === 1 ? `${l}改了` : l)).join("\n")}\n多一行\n`,
    );
    box.sh(app.dir, "commit", "-q", "-am", "Agent 的提交");
    writeFileSync(join(app.dir, "new.txt"), "新的\n");
    writeFileSync(join(app.dir, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
    box.sh(app.dir, "mv", "README.md", "README.zh.md");

    const [outcome] = await finishTurn(box.exec, git, { repos, starts, turnNumber: 3 });
    expect(outcome?.push).toBe("pushed");
    expect(outcome?.error).toBeUndefined();
    expect(outcome?.savedCommit).toBe(outcome?.head);
    expect(box.sh(app.dir, "log", "-1", "--format=%s")).toBe(
      "SeekCloud：保存第 3 回合未提交的改动",
    );
    expect(box.sh(app.dir, "status", "--porcelain")).toBe("");
    expect(box.remoteHead(app.bare)).toBe(outcome?.head);
    expect(outcome?.files).toEqual(
      expect.arrayContaining([
        { path: "README.zh.md", from: "README.md", additions: 2, deletions: 1 },
        { path: "new.txt", additions: 1, deletions: 0 },
        { path: "logo.png", additions: 0, deletions: 0, binary: true },
      ]),
    );
    expect(outcome?.files).toHaveLength(3);
  });

  it("Agent 自己全部提交了：不补提交，只推送；什么都没改：文件列表是空的", async () => {
    const box = sandbox(["app"]);
    const [app] = box.repos as [(typeof box.repos)[0]];
    const repos = [box.session("app")];
    let starts = await turnStart(box.exec, repos);
    writeFileSync(join(app.dir, "a.txt"), "a\n");
    box.sh(app.dir, "add", ".");
    box.sh(app.dir, "commit", "-q", "-m", "Agent 提交");
    const [first] = await finishTurn(box.exec, git, { repos, starts, turnNumber: 1 });
    expect(first?.savedCommit).toBeUndefined();
    expect(first?.push).toBe("pushed");
    expect(first?.files).toEqual([{ path: "a.txt", additions: 1, deletions: 0 }]);

    starts = await turnStart(box.exec, repos);
    const [second] = await finishTurn(box.exec, git, { repos, starts, turnNumber: 2 });
    expect(second).toMatchObject({ push: "pushed", files: [] });
    expect(second?.savedCommit).toBeUndefined();
  });

  it("只读挂载的仓库：照样补提交，不推送", async () => {
    const box = sandbox(["lib"]);
    const [lib] = box.repos as [(typeof box.repos)[0]];
    const repos = [box.session("lib", "read")];
    const starts = await turnStart(box.exec, repos);
    writeFileSync(join(lib.dir, "x.txt"), "x\n");
    const [outcome] = await finishTurn(box.exec, git, { repos, starts });
    expect(outcome?.push).toBe("read_only");
    expect(outcome?.savedCommit).toBeDefined();
    expect(box.sh(lib.dir, "log", "-1", "--format=%s")).toBe("SeekCloud：保存这一回合未提交的改动");
    expect(box.remoteHead(lib.bare)).toBe("");
  });

  it("Agent 切到了别的分支：不补提交，算推送失败并说明原因；会话分支照样推上去", async () => {
    const box = sandbox(["app"]);
    const [app] = box.repos as [(typeof box.repos)[0]];
    const repos = [box.session("app")];
    const starts = await turnStart(box.exec, repos);
    box.sh(app.dir, "checkout", "-q", "-b", "experiment");
    writeFileSync(join(app.dir, "x.txt"), "x\n");
    const [outcome] = await finishTurn(box.exec, git, { repos, starts });
    expect(outcome?.push).toBe("failed");
    expect(outcome?.error).toContain(`不在会话分支 ${BRANCH} 上（现在在 experiment）`);
    expect(outcome?.savedCommit).toBeUndefined();
    expect(box.sh(app.dir, "status", "--porcelain")).toContain("x.txt");
    expect(box.remoteHead(app.bare)).toBe(box.sh(app.dir, "rev-parse", BRANCH));
  });

  it("远端会话分支有本地没有的提交：不强推，算推送失败，带上 git 的原话", async () => {
    const box = sandbox(["app"]);
    const [app] = box.repos as [(typeof box.repos)[0]];
    const repos = [box.session("app")];
    // 远端的会话分支上有别人推的提交
    const other = mkdtempSync(join(tmpdir(), "other-"));
    execFileSync("git", ["clone", "-q", app.bare, other], { env: cleanGitEnv(other) });
    box.sh(other, "checkout", "-q", "-b", BRANCH);
    writeFileSync(join(other, "theirs.txt"), "别人的\n");
    box.sh(other, "add", ".");
    box.sh(other, "commit", "-q", "-m", "别人的提交");
    box.sh(other, "push", "-q", "origin", BRANCH);
    const theirs = box.remoteHead(app.bare);

    const starts = await turnStart(box.exec, repos);
    writeFileSync(join(app.dir, "mine.txt"), "我的\n");
    const [outcome] = await finishTurn(box.exec, git, { repos, starts });
    expect(outcome?.push).toBe("failed");
    expect(outcome?.error).toMatch(
      /推送 seekcloud\/abc123 失败：[\s\S]*(rejected|fetch first|non-fast-forward)/,
    );
    expect(outcome?.savedCommit).toBeDefined();
    expect(box.remoteHead(app.bare)).toBe(theirs);
  });

  it("几个仓库各算各的：名字重了的目录带 owner", async () => {
    const box = sandbox(["app", "lib"]);
    const [app, lib] = box.repos as [(typeof box.repos)[0], (typeof box.repos)[0]];
    const repos = [box.session("app"), box.session("lib")];
    const starts = await turnStart(box.exec, repos);
    writeFileSync(join(lib.dir, "only-lib.txt"), "x\n");
    const outcomes = await finishTurn(box.exec, git, { repos, starts });
    expect(outcomes.map((o) => [o.fullName, o.files.length, Boolean(o.savedCommit)])).toEqual([
      ["acme/app", 0, false],
      ["acme/lib", 1, true],
    ]);
    expect(box.remoteHead(app.bare)).not.toBe("");
  });
});
