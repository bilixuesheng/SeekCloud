// 主站调用 GitHub 的全部能力。测试里换成 src/testing/fake-github.ts。

export interface GitHubUser {
  id: string;
  login: string;
}

export interface GitHubTokens {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  /** 用户装了 SeekCloud 的 GitHub App，可以推送；否则只能只读挂载公开仓库。 */
  canPush: boolean;
}

export interface GitHub {
  /** 安装 GitHub App 的页面，用户在那里选给哪些仓库装。 */
  readonly installUrl: string;
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<GitHubTokens>;
  refreshTokens(refreshToken: string): Promise<GitHubTokens>;
  getUser(accessToken: string): Promise<GitHubUser>;
  /** 已验证的主邮箱，没有就返回 undefined。 */
  getPrimaryEmail(accessToken: string): Promise<string | undefined>;
  listInstalledRepos(accessToken: string): Promise<Repo[]>;
  searchPublicRepos(accessToken: string, query: string): Promise<Repo[]>;
  /** 一个公开仓库（只读）。不存在或者是私有仓库时返回 undefined。 */
  getPublicRepo(accessToken: string, fullName: string): Promise<Repo | undefined>;
  listBranches(accessToken: string, fullName: string): Promise<string[]>;
  /** 校验 GitHub webhook 的签名（X-Hub-Signature-256）。 */
  verifyWebhook(body: string, signature: string | undefined): boolean;
}

/** 调 GitHub 出错，比如网络不通、被限流。 */
export class GitHubError extends Error {}

/** GitHub 不认这个令牌了：用户撤销了授权，或者刷新令牌失效。要用户重新授权。 */
export class GitHubAuthError extends GitHubError {}
