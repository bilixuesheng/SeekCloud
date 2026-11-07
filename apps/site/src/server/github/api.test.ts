import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubApi } from "./api";
import { GitHubAuthError } from "./port";

type Call = { url: string; init: RequestInit };

function api(respond: (url: string) => unknown, calls: Call[] = [], status = 200) {
  return githubApi({
    clientId: "Iv1.test",
    clientSecret: "secret",
    appSlug: "seekcloud",
    webhookSecret: "hook",
    callbackUrl: "https://seekcloud.test/api/auth/github/callback",
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(respond(String(url))), { status });
    },
  });
}

describe("真实 GitHub 接口的调用方式", () => {
  it("授权地址带上 client_id、跳回地址和 state", () => {
    const url = new URL(api(() => ({})).authorizeUrl("abc"));

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "Iv1.test",
      redirect_uri: "https://seekcloud.test/api/auth/github/callback",
      state: "abc",
    });
  });

  it("用授权码换令牌，按返回的秒数算出过期时间", async () => {
    const calls: Call[] = [];
    const before = Date.now();
    const tokens = await api(
      () => ({
        access_token: "gho_1",
        expires_in: 28800,
        refresh_token: "ghr_1",
        refresh_token_expires_in: 15897600,
      }),
      calls,
    ).exchangeCode("code-1");

    expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      client_id: "Iv1.test",
      client_secret: "secret",
      code: "code-1",
    });
    expect(tokens.accessToken).toBe("gho_1");
    expect(tokens.accessExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 28_800_000);
    expect(tokens.refreshToken).toBe("ghr_1");
  });

  it("授权码或刷新令牌失效时抛出 GitHubAuthError，要用户重新授权", async () => {
    await expect(
      api(() => ({ error: "bad_refresh_token" })).refreshTokens("x"),
    ).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("分支超过 100 个时翻页取全", async () => {
    const page = (n: number, size: number) =>
      Array.from({ length: size }, (_, i) => ({ name: `b${n}-${i}` }));
    const branches = await api((url) =>
      url.endsWith("&page=1") ? page(1, 100) : page(2, 3),
    ).listBranches("gho_1", "a/b");

    expect(branches).toHaveLength(103);
  });

  it("公开仓库：私有的和不存在的都返回 undefined", async () => {
    const repo = (isPrivate: boolean) => ({
      full_name: "a/b",
      private: isPrivate,
      default_branch: "main",
    });

    expect(await api(() => repo(false)).getPublicRepo("gho_1", "a/b")).toEqual({
      fullName: "a/b",
      private: false,
      defaultBranch: "main",
      canPush: false,
    });
    expect(await api(() => repo(true)).getPublicRepo("gho_1", "a/b")).toBeUndefined();
    expect(
      await api(() => ({ message: "Not Found" }), [], 404).getPublicRepo("gho_1", "a/b"),
    ).toBeUndefined();
  });

  it("主邮箱：只取已验证的主邮箱，转成小写", async () => {
    const email = await api(() => [
      { email: "Other@Example.com", primary: false, verified: true },
      { email: "Me@Example.com", primary: true, verified: true },
    ]).getPrimaryEmail("gho_1");

    expect(email).toBe("me@example.com");
  });

  it("webhook 签名：用 webhook 密钥算出的签名才算对", () => {
    const github = api(() => ({}));
    const body = '{"action":"created"}';
    const good = `sha256=${createHmac("sha256", "hook").update(body).digest("hex")}`;

    expect(github.verifyWebhook(body, good)).toBe(true);
    expect(github.verifyWebhook(body, "sha256=00")).toBe(false);
    expect(github.verifyWebhook(body, undefined)).toBe(false);
  });
});
