import { createHmac, randomUUID } from "node:crypto";
import type { GitHub, GitHubTokens, Repo } from "../server/github/port";
import { GitHubAuthError, GitHubError } from "../server/github/port";
import type { Clock } from "../server/ports";

const HOUR = 3_600_000;

export interface FakeUser {
  id: string;
  login: string;
  email?: string;
  installed: Repo[];
}

/** 内存里的 GitHub：有用户、授权码、会过期的令牌、装了 App 的仓库和公开仓库。 */
export class FakeGitHub implements GitHub {
  readonly installUrl = "https://github.com/apps/seekcloud-test/installations/new";
  readonly webhookSecret = "test-webhook-secret";
  readonly #clock: Clock;
  readonly #users = new Map<string, FakeUser>();
  readonly #codes = new Map<string, string>();
  readonly #access = new Map<string, { userId: string; expiresAt: Date }>();
  readonly #refresh = new Map<string, { userId: string; expiresAt: Date }>();
  readonly #publicRepos: Repo[] = [];
  readonly #branches = new Map<string, string[]>();
  refreshCount = 0;
  #nextFailure: Error | undefined;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  addUser(user: { login: string; email?: string }): FakeUser {
    const created = { id: String(1000 + this.#users.size), installed: [], ...user };
    this.#users.set(created.id, created);
    return created;
  }

  /** 用户在 GitHub 上点了"授权"，GitHub 带着这个授权码跳回来。 */
  authorize(user: FakeUser): string {
    const code = randomUUID();
    this.#codes.set(code, user.id);
    return code;
  }

  install(user: FakeUser, ...repos: Array<{ fullName: string; private?: boolean }>): void {
    for (const repo of repos) {
      user.installed.push({ private: true, defaultBranch: "main", canPush: true, ...repo });
    }
  }

  uninstall(user: FakeUser, fullName: string): void {
    user.installed = user.installed.filter((r) => r.fullName !== fullName);
  }

  /** 用户在 GitHub 上撤销了对 SeekCloud 的授权：所有令牌作废。 */
  revoke(user: FakeUser): void {
    for (const [token, entry] of [...this.#access, ...this.#refresh]) {
      if (entry.userId === user.id) {
        this.#access.delete(token);
        this.#refresh.delete(token);
      }
    }
  }

  /** 下一次调用失败，模拟 GitHub 不可用。 */
  failNext(): void {
    this.#nextFailure = new GitHubError("GitHub 不可用");
  }

  addPublicRepo(fullName: string): void {
    this.#publicRepos.push({ fullName, private: false, defaultBranch: "main", canPush: false });
  }

  setBranches(fullName: string, branches: string[]): void {
    this.#branches.set(fullName, branches);
  }

  sign(body: string): string {
    return `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`;
  }

  authorizeUrl(state: string): string {
    return `https://github.com/login/oauth/authorize?client_id=test&state=${state}`;
  }

  async exchangeCode(code: string): Promise<GitHubTokens> {
    const userId = this.#codes.get(code);
    this.#codes.delete(code);
    if (!userId) throw new GitHubError("授权码无效");
    return this.#issue(userId);
  }

  async refreshTokens(refreshToken: string): Promise<GitHubTokens> {
    // 模拟网络延迟，让同时到达的刷新请求真的交错。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const entry = this.#refresh.get(refreshToken);
    this.#refresh.delete(refreshToken);
    if (!entry || entry.expiresAt <= this.#clock.now()) throw new GitHubAuthError("刷新令牌无效");
    this.refreshCount++;
    return this.#issue(entry.userId);
  }

  async getUser(accessToken: string) {
    const user = this.#userFor(accessToken);
    return { id: user.id, login: user.login };
  }

  async getPrimaryEmail(accessToken: string) {
    return this.#userFor(accessToken).email;
  }

  async listInstalledRepos(accessToken: string) {
    this.#maybeFail();
    return [...this.#userFor(accessToken).installed];
  }

  async searchPublicRepos(accessToken: string, query: string) {
    this.#userFor(accessToken);
    return this.#publicRepos.filter((r) => r.fullName.includes(query));
  }

  async getPublicRepo(accessToken: string, fullName: string) {
    this.#userFor(accessToken);
    return this.#publicRepos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
  }

  async listBranches(accessToken: string, fullName: string) {
    this.#userFor(accessToken);
    return this.#branches.get(fullName) ?? ["main"];
  }

  verifyWebhook(body: string, signature: string | undefined): boolean {
    return signature === this.sign(body);
  }

  #issue(userId: string): GitHubTokens {
    const now = this.#clock.now().getTime();
    const tokens = {
      accessToken: `gho_${randomUUID()}`,
      accessExpiresAt: new Date(now + 8 * HOUR),
      refreshToken: `ghr_${randomUUID()}`,
      refreshExpiresAt: new Date(now + 6 * 30 * 24 * HOUR),
    };
    this.#access.set(tokens.accessToken, { userId, expiresAt: tokens.accessExpiresAt });
    this.#refresh.set(tokens.refreshToken, { userId, expiresAt: tokens.refreshExpiresAt });
    return tokens;
  }

  #maybeFail(): void {
    const failure = this.#nextFailure;
    this.#nextFailure = undefined;
    if (failure) throw failure;
  }

  #userFor(accessToken: string): FakeUser {
    const entry = this.#access.get(accessToken);
    if (!entry || entry.expiresAt <= this.#clock.now()) {
      throw new GitHubAuthError("令牌无效或已过期");
    }
    return this.#users.get(entry.userId) as FakeUser;
  }
}
