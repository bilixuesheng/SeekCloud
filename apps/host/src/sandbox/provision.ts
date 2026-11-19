import type { Committer, SessionRepo } from "@seekcloud/protocol";
import type { Sandboxes } from "./sandboxes";

/**
 * 准备沙箱时把工作区配好（#27，apps/host/sandbox/README.md 的"沙箱里的 Git 配置"）：
 *
 * - 代理的 CA 证书装进沙箱的信任列表：Git 代理解密 GitHub 的流量用的是它签的证书；
 * - 写 /etc/gitconfig：提交身份（管理员关联的 GitHub 账号）、用宿主机的签名服务签名、
 *   只有 github.com 走 Git 代理（别的出站在出站代理做好之前直连，#47）；
 * - 克隆会话的仓库到 /workspace/<名字>，切到会话分支：远端已经有（重建的沙箱）就接着它，没有就从基础分支新开。
 *
 * 凭据不进沙箱（ADR 0003）：沙箱里只有会话临时令牌，GitHub 的令牌在宿主机的 Git 代理里换上。
 */

/** 宿主机这边、每个会话都一样的：Git 代理在哪、它的 CA、签名公钥。 */
export interface SandboxGit {
  /** 沙箱连 Git 代理的地址（网桥上的）。 */
  proxy: { host: string; port: number };
  caPem: string;
  /** 签名公钥，一行 "ssh-ed25519 AAAA…"。 */
  signingPublicKey: string;
  /** 主站没下发提交身份时用的（旧版本的主站）：宿主机配置的 SeekCloud 账号。 */
  fallbackCommitter?: Committer;
}

/** 每个会话不同的。 */
export interface WorkspaceSetup {
  sessionToken: string;
  committer?: Committer;
  repos: SessionRepo[];
}

/** 克隆失败：会话以"克隆仓库失败"告诉管理员（ERROR_CODES 的 repo_clone_failed）。 */
export class CloneError extends Error {}

export const WORKSPACE = "/workspace";
export const CA_PATH = "/etc/seekcloud/proxy-ca.crt";

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** git 的分支名：不能以 - 开头（会被当成选项），不能有空白和 git 不认的字符。 */
export function isSafeBranch(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith("-") &&
    ![...name].some((c) => (c.codePointAt(0) ?? 0) < 0x20 || c === "\u007f") &&
    !/[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|\.$/.test(name)
  );
}

/** 每个仓库克隆到哪：/workspace/<名字>；名字重了的用 <owner>-<名字>。第一个是主仓库（Agent 的工作目录）。 */
export function workspaceDirs(repos: readonly Pick<SessionRepo, "fullName">[]): string[] {
  const names = repos.map((r) => r.fullName.split("/")[1] ?? r.fullName);
  return repos.map((r, i) => {
    const name = names[i] as string;
    const clash = names.filter((n) => n === name).length > 1;
    return `${WORKSPACE}/${clash ? r.fullName.replace("/", "-") : name}`;
  });
}

/** 沙箱里的 git 从哪里连 Git 代理：代理认证用会话临时令牌（ADR 0003）。 */
export function proxyUrl(git: SandboxGit, sessionToken: string): string {
  return `http://session:${encodeURIComponent(sessionToken)}@${git.proxy.host}:${git.proxy.port}`;
}

/** git 配置文件里的一个值：加引号，转义反斜杠和引号；有换行的不收。 */
function quote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("git 配置的值里不能有换行");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** /etc/gitconfig 的全文（git config --system）。 */
export function gitConfig(git: SandboxGit, setup: WorkspaceSetup): string {
  const committer = setup.committer ?? git.fallbackCommitter;
  const lines: string[] = [];
  if (committer) {
    lines.push(
      "[user]",
      `\tname = ${quote(committer.name)}`,
      `\temail = ${quote(committer.email)}`,
    );
    lines.push(`\tsigningkey = ${quote(`key::${git.signingPublicKey}`)}`);
  }
  lines.push(
    "[gpg]",
    "\tformat = ssh",
    '[gpg "ssh"]',
    "\tprogram = /usr/local/bin/seekcloud-sign",
    "[commit]",
    `\tgpgsign = ${committer ? "true" : "false"}`,
    '[url "https://github.com/"]',
    "\tinsteadOf = git@github.com:",
    "\tinsteadOf = ssh://git@github.com/",
    "[push]",
    "\tnegotiate = true",
    "[http]",
    // 第一次请求就带上代理凭据，省一个来回
    "\tproxyAuthMethod = basic",
    '[http "https://github.com/"]',
    `\tproxy = ${quote(proxyUrl(git, setup.sessionToken))}`,
    // 克隆的仓库是 root 的，Agent 也是 root：不用 safe.directory
    "",
  );
  return lines.join("\n");
}

/** 沙箱里跑 git、gh、签名助手时要的环境变量（准备工作区、Agent 的进程都用）。 */
export function sandboxGitEnv(git: SandboxGit, sessionToken: string): Record<string, string> {
  return {
    SEEKCLOUD_SESSION_TOKEN: sessionToken,
    SEEKCLOUD_SIGN_URL: `http://${git.proxy.host}:${git.proxy.port}/sign`,
    // gh 只在调 GitHub 时走 Git 代理（镜像里的 gh 包装脚本读它）；令牌是占位符，代理换成用户的
    SEEKCLOUD_GITHUB_PROXY: proxyUrl(git, sessionToken),
    GH_TOKEN: "proxy-injected",
    GITHUB_TOKEN: "proxy-injected",
    NODE_EXTRA_CA_CERTS: CA_PATH,
    // 提交说明里的 AI 标识：用环境变量设 hooksPath，盖过仓库自己的（apps/host/sandbox/README.md）
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/usr/local/share/seekcloud/git-hooks",
    GIT_TERMINAL_PROMPT: "0",
    // 宿主机本地的服务（模型网关的转发、签名）直连，不经过任何代理
    NO_PROXY: git.proxy.host,
    no_proxy: git.proxy.host,
  };
}

/** 准备工作区：装 CA、写 git 配置、克隆仓库、切到会话分支。重复做没有坏处（已经克隆过的跳过）。 */
export async function provisionWorkspace(
  sandboxes: Sandboxes,
  sessionId: string,
  git: SandboxGit,
  setup: WorkspaceSetup,
): Promise<void> {
  for (const repo of setup.repos) {
    if (!REPO_NAME.test(repo.fullName) || repo.fullName.split("/").some((p) => /^\.+$/.test(p))) {
      throw new CloneError(`仓库名不对：${repo.fullName}`);
    }
    if (!isSafeBranch(repo.baseBranch) || !isSafeBranch(repo.branch)) {
      throw new CloneError(`分支名不对：${repo.baseBranch} / ${repo.branch}`);
    }
  }
  await sandboxes.writeFile(sessionId, CA_PATH, git.caPem);
  await sandboxes.writeFile(
    sessionId,
    "/usr/local/share/ca-certificates/seekcloud-proxy.crt",
    git.caPem,
  );
  // 通用镜像里有 update-ca-certificates；别的镜像没有就算了（git 只认系统的信任列表时会克隆失败，报出来）
  await sandboxes.exec(
    sessionId,
    [
      "sh",
      "-c",
      "command -v update-ca-certificates >/dev/null && update-ca-certificates >/dev/null 2>&1; true",
    ],
    {
      user: "0",
      timeoutMs: 60_000,
    },
  );
  await sandboxes.writeFile(sessionId, "/etc/gitconfig", gitConfig(git, setup));

  const env = sandboxGitEnv(git, setup.sessionToken);
  const dirs = workspaceDirs(setup.repos);
  const run = async (argv: string[], what: string, cwd?: string) => {
    const result = await sandboxes.exec(sessionId, argv, {
      env,
      cwd,
      user: "0",
      timeoutMs: 10 * 60_000,
    });
    return {
      ok: result.exitCode === 0,
      detail: `${what}：${(result.stderr || result.stdout).trim().slice(-500)}`,
    };
  };
  for (const [i, repo] of setup.repos.entries()) {
    const dir = dirs[i] as string;
    const exists = await sandboxes.exec(sessionId, ["test", "-d", `${dir}/.git`], { user: "0" });
    if (exists.exitCode === 0) continue; // 休眠后唤醒：仓库还在，接着用
    const clone = await run(
      [
        "git",
        "clone",
        "--depth",
        "50",
        `--branch=${repo.baseBranch}`,
        "--",
        `https://github.com/${repo.fullName}.git`,
        dir,
      ],
      `克隆 ${repo.fullName}`,
    );
    if (!clone.ok) throw new CloneError(clone.detail);
    // 会话分支：远端已经有（沙箱重建过）就接着它，没有就从基础分支新开
    const fetched = await run(
      ["git", "fetch", "--depth", "50", "origin", `refs/heads/${repo.branch}`],
      `取 ${repo.branch}`,
      dir,
    );
    const checkout = fetched.ok
      ? await run(["git", "checkout", "-B", repo.branch, "FETCH_HEAD"], `切到 ${repo.branch}`, dir)
      : await run(["git", "checkout", "-b", repo.branch], `新开 ${repo.branch}`, dir);
    if (!checkout.ok) throw new CloneError(checkout.detail);
  }
}
