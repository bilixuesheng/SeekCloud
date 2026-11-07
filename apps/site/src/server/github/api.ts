import { createHmac, timingSafeEqual } from "node:crypto";
import { type GitHub, GitHubAuthError, GitHubError, type GitHubTokens, type Repo } from "./port";

interface Options {
  clientId: string;
  clientSecret: string;
  /** GitHub App 的短名字，用来拼安装页面的地址。 */
  appSlug: string;
  webhookSecret: string;
  /** 授权后 GitHub 跳回来的地址。 */
  callbackUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** 真实的 GitHub：用 GitHub App 的用户授权令牌调 REST 接口。 */
export function githubApi(options: Options): GitHub {
  const doFetch = options.fetch ?? globalThis.fetch;

  async function call<T>(token: string, path: string): Promise<T> {
    const result = await callOptional<T>(token, path);
    if (result === undefined) throw new GitHubError(`GitHub 返回 404：${path}`);
    return result;
  }

  /** 和 call 一样，但 404 时返回 undefined。 */
  async function callOptional<T>(token: string, path: string): Promise<T | undefined> {
    const res = await doFetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (res.status === 401) throw new GitHubAuthError(`GitHub 不认这个令牌：${path}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new GitHubError(`GitHub 返回 ${res.status}：${path}`);
    return (await res.json()) as T;
  }

  async function oauth(params: Record<string, string>): Promise<GitHubTokens> {
    const res = await doFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        ...params,
      }),
    });
    const body = (await res.json()) as Record<string, string | number | undefined>;
    if (!res.ok || !body.access_token) {
      // 授权码或刷新令牌失效：要用户重新授权。其他情况算 GitHub 暂时有问题。
      const invalid = body.error === "bad_verification_code" || body.error === "bad_refresh_token";
      const Failure = invalid ? GitHubAuthError : GitHubError;
      throw new Failure(`GitHub 授权失败：${body.error ?? res.status}`);
    }
    const now = Date.now();
    return {
      accessToken: String(body.access_token),
      accessExpiresAt: new Date(now + Number(body.expires_in) * 1000),
      refreshToken: String(body.refresh_token),
      refreshExpiresAt: new Date(now + Number(body.refresh_token_expires_in) * 1000),
    };
  }

  type ApiRepo = {
    full_name: string;
    private: boolean;
    default_branch: string;
    permissions?: { push?: boolean };
  };
  const toRepo = (r: ApiRepo, installed: boolean): Repo => ({
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    canPush: installed && r.permissions?.push !== false,
  });

  return {
    installUrl: `https://github.com/apps/${options.appSlug}/installations/new`,

    authorizeUrl(state) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", options.callbackUrl);
      url.searchParams.set("state", state);
      return url.toString();
    },

    exchangeCode: (code) => oauth({ code, redirect_uri: options.callbackUrl }),
    refreshTokens: (refreshToken) =>
      oauth({ grant_type: "refresh_token", refresh_token: refreshToken }),

    async getUser(token) {
      const user = await call<{ id: number; login: string }>(token, "/user");
      return { id: String(user.id), login: user.login };
    },

    async getPrimaryEmail(token) {
      const emails = await call<Array<{ email: string; primary: boolean; verified: boolean }>>(
        token,
        "/user/emails",
      );
      return emails.find((e) => e.primary && e.verified)?.email.toLowerCase();
    },

    async listInstalledRepos(token) {
      const { installations } = await call<{ installations: Array<{ id: number }> }>(
        token,
        "/user/installations?per_page=100",
      );
      const repos: Repo[] = [];
      for (const { id } of installations) {
        for (let page = 1; ; page++) {
          const batch = await call<{ repositories: ApiRepo[] }>(
            token,
            `/user/installations/${id}/repositories?per_page=100&page=${page}`,
          );
          repos.push(...batch.repositories.map((r) => toRepo(r, true)));
          if (batch.repositories.length < 100) break;
        }
      }
      return repos;
    },

    async searchPublicRepos(token, query) {
      const q = encodeURIComponent(`${query} is:public`);
      const { items } = await call<{ items: ApiRepo[] }>(
        token,
        `/search/repositories?q=${q}&per_page=20`,
      );
      return items.map((r) => toRepo(r, false));
    },

    async getPublicRepo(token, fullName) {
      const repo = await callOptional<ApiRepo>(token, `/repos/${fullName}`);
      return repo && !repo.private ? toRepo(repo, false) : undefined;
    },

    async listBranches(token, fullName) {
      const names: string[] = [];
      // 最多翻 10 页（1000 个分支），够用了。
      for (let page = 1; page <= 10; page++) {
        const batch = await call<Array<{ name: string }>>(
          token,
          `/repos/${fullName}/branches?per_page=100&page=${page}`,
        );
        names.push(...batch.map((b) => b.name));
        if (batch.length < 100) break;
      }
      return names;
    },

    verifyWebhook(body, signature) {
      if (!signature) return false;
      const expected = `sha256=${createHmac("sha256", options.webhookSecret).update(body).digest("hex")}`;
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}

/** 没配 GitHub App 时用它：所有调用都报错。 */
export const unconfiguredGitHub: GitHub = new Proxy({} as GitHub, {
  get(_, prop) {
    if (prop === "installUrl") return "";
    return () => {
      throw new GitHubError("GitHub App 还没有配置");
    };
  },
});
