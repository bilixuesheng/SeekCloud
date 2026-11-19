import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CloneError,
  DSH_SCRUBBED_ENV,
  gitConfig,
  githubEnvFile,
  isSafeBranch,
  provisionWorkspace,
  type SandboxGit,
  sandboxGitEnv,
  workspaceDirs,
} from "./provision";
import type { ExecOptions, ExecResult, Sandboxes } from "./sandboxes";

const git: SandboxGit = {
  proxy: { host: "10.88.0.1", port: 8080 },
  caPem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
  signingPublicKey: "ssh-ed25519 AAAAC3Nz",
  fallbackCommitter: { name: "SeekCloud", email: "bot@example.com" },
};
const repo = (fullName: string, branch = "seekcloud/abc123") => ({
  fullName,
  baseBranch: "main",
  branch,
  access: "push" as const,
});

/** 假沙箱：记下写的文件和跑的命令，按 answer 回结果。 */
function fakeSandboxes(answer: (argv: string[]) => Partial<ExecResult> = () => ({})) {
  const files = new Map<string, string>();
  const runs: { argv: string[]; cwd?: string; env?: Record<string, string> }[] = [];
  const sandboxes = {
    async writeFile(_id: string, path: string, content: string) {
      files.set(path, content);
    },
    async exec(_id: string, argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
      runs.push({ argv, cwd: options.cwd, env: options.env });
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...answer(argv) };
    },
  } as unknown as Sandboxes;
  return { sandboxes, files, runs };
}

describe("沙箱的工作区", () => {
  it("分支名：不收会被当成选项的、git 不认的", () => {
    for (const ok of ["main", "seekcloud/abc123", "release-1.2", "feat/中文"]) {
      expect(isSafeBranch(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "-x",
      "--upload-pack=sh",
      "a b",
      "a..b",
      "a~1",
      "a:b",
      "x.lock",
      "/a",
      "a/",
      "a//b",
      "a@{1}",
      "a\u0001b",
      "a\\b",
    ]) {
      expect(isSafeBranch(bad), bad).toBe(false);
    }
  });

  it("仓库克隆到 /workspace/<名字>，名字重了的带上 owner；第一个是主仓库", () => {
    expect(workspaceDirs([{ fullName: "acme/app" }, { fullName: "acme/lib" }])).toEqual([
      "/workspace/app",
      "/workspace/lib",
    ]);
    expect(workspaceDirs([{ fullName: "acme/app" }, { fullName: "mona/app" }])).toEqual([
      "/workspace/acme-app",
      "/workspace/mona-app",
    ]);
    expect(workspaceDirs([])).toEqual([]);
  });

  it("git 配置：会话的提交身份、宿主机签名、只有 github.com 走 Git 代理", () => {
    const config = gitConfig(git, {
      sessionToken: "tok/+=",
      committer: { name: 'Mona "the" Cat', email: "1+mona@users.noreply.github.com" },
      repos: [],
    });
    expect(config).toContain('\tname = "Mona \\"the\\" Cat"');
    expect(config).toContain('\temail = "1+mona@users.noreply.github.com"');
    expect(config).toContain('\tsigningkey = "key::ssh-ed25519 AAAAC3Nz"');
    expect(config).toContain("\tprogram = /usr/local/bin/seekcloud-sign");
    expect(config).toContain("\tgpgsign = true");
    expect(config).toContain('[http "https://github.com/"]');
    expect(config).toContain('\tproxy = "http://session:tok%2F%2B%3D@10.88.0.1:8080"');

    // 主站没下发提交身份：用宿主机配置的
    expect(gitConfig(git, { sessionToken: "t", repos: [] })).toContain(
      '\temail = "bot@example.com"',
    );
    // 都没有：不签名（签名服务也不会签）
    const bare = gitConfig(
      { ...git, fallbackCommitter: undefined },
      { sessionToken: "t", repos: [] },
    );
    expect(bare).not.toContain("[user]");
    expect(bare).toContain("\tgpgsign = false");
    // 换行进不了配置文件
    expect(() =>
      gitConfig(git, {
        sessionToken: "t",
        committer: { name: "a\n[core]", email: "e" },
        repos: [],
      }),
    ).toThrow();
  });

  it("环境变量：钩子、CA、宿主机本地的服务不走代理；名字都躲开 dsh 的过滤", () => {
    const env = sandboxGitEnv(git);
    expect(env).toMatchObject({
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/usr/local/share/seekcloud/git-hooks'",
      NODE_EXTRA_CA_CERTS: "/etc/seekcloud/proxy-ca.crt",
      NO_PROXY: "10.88.0.1",
    });
    expect(env.HTTPS_PROXY).toBeUndefined();
    // dsh 不把名字带 KEY、TOKEN 这类词的环境变量传给它跑的命令
    for (const name of Object.keys(env)) expect(name).not.toMatch(DSH_SCRUBBED_ENV);
    // 会话临时令牌也不在环境变量里
    expect(JSON.stringify(env)).not.toContain("tok");
  });

  it("github.env：签名助手和 gh 的包装脚本 source 它，拿到令牌、签名服务和代理的地址", () => {
    const file = githubEnvFile(git, "it's-a-token");
    const out = execFileSync(
      "sh",
      [
        "-c",
        'eval "$(cat)"; printf "%s\\n" "$SEEKCLOUD_SESSION_TOKEN" "$SEEKCLOUD_SIGN_URL" "$SEEKCLOUD_GITHUB_PROXY"',
      ],
      { input: file, encoding: "utf8" },
    );
    expect(out.split("\n").slice(0, 3)).toEqual([
      "it's-a-token",
      "http://10.88.0.1:8080/sign",
      "http://session:it's-a-token@10.88.0.1:8080",
    ]);
  });

  it("装 CA、写配置、克隆、切到会话分支：远端有会话分支就接着它，没有就新开", async () => {
    let fetches = 0;
    // 两个仓库都还没克隆；lib（第二个取会话分支的）远端还没有会话分支
    const { sandboxes, files, runs } = fakeSandboxes((argv) => {
      if (argv[0] === "test") return { exitCode: 1 };
      if (argv[1] === "fetch" && ++fetches === 2) {
        return { exitCode: 128, stderr: "fatal: couldn't find remote ref" };
      }
      return {};
    });
    await provisionWorkspace(sandboxes, "s1", git, {
      sessionToken: "tok",
      repos: [repo("acme/app"), repo("acme/lib")],
    });
    expect(files.get("/etc/seekcloud/proxy-ca.crt")).toBe(git.caPem);
    expect(files.get("/usr/local/share/ca-certificates/seekcloud-proxy.crt")).toBe(git.caPem);
    expect(files.get("/etc/gitconfig")).toContain('\temail = "bot@example.com"');
    expect(files.get("/etc/seekcloud/github.env")).toContain("SEEKCLOUD_SESSION_TOKEN='tok'");
    const gits = runs.filter((r) => r.argv[0] === "git");
    expect(gits.map((r) => [r.argv.slice(1).join(" "), r.cwd])).toEqual([
      [
        "clone --depth 50 --branch=main -- https://github.com/acme/app.git /workspace/app",
        undefined,
      ],
      ["fetch --depth 50 origin refs/heads/seekcloud/abc123", "/workspace/app"],
      ["checkout -B seekcloud/abc123 FETCH_HEAD", "/workspace/app"],
      [
        "clone --depth 50 --branch=main -- https://github.com/acme/lib.git /workspace/lib",
        undefined,
      ],
      ["fetch --depth 50 origin refs/heads/seekcloud/abc123", "/workspace/lib"],
      ["checkout -b seekcloud/abc123", "/workspace/lib"],
    ]);
    expect(gits[0]?.env?.GIT_CONFIG_PARAMETERS).toContain("core.hooksPath");
  });

  it("已经克隆过的（休眠后唤醒）不再克隆；克隆失败、名字不对时报克隆失败", async () => {
    const done = fakeSandboxes();
    await provisionWorkspace(done.sandboxes, "s1", git, {
      sessionToken: "t",
      repos: [repo("acme/app")],
    });
    expect(done.runs.filter((r) => r.argv[0] === "git")).toEqual([]);
    expect(done.files.has("/etc/gitconfig")).toBe(true); // 新的会话临时令牌照样写进去

    const failing = fakeSandboxes((argv) =>
      argv[0] === "test"
        ? { exitCode: 1 }
        : argv[1] === "clone"
          ? { exitCode: 128, stderr: "fatal: repository not found" }
          : {},
    );
    await expect(
      provisionWorkspace(failing.sandboxes, "s1", git, {
        sessionToken: "t",
        repos: [repo("acme/app")],
      }),
    ).rejects.toThrow(CloneError);

    for (const bad of [
      repo("acme/app", "--upload-pack=touch /x"),
      repo("../etc"),
      { ...repo("acme/app"), baseBranch: "-c" },
    ]) {
      const box = fakeSandboxes();
      await expect(
        provisionWorkspace(box.sandboxes, "s1", git, { sessionToken: "t", repos: [bad] }),
      ).rejects.toThrow(CloneError);
      expect(box.runs).toEqual([]);
    }
  });
});
