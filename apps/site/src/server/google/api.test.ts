import { describe, expect, it } from "vitest";
import { googleApi } from "./api";

const NOW = new Date("2026-11-01T00:00:00Z");

/** 拼一个 ID 令牌（不签名：主站直接从 Google 的令牌接口拿，按 OIDC 规定可以不验签名）。 */
function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

const good = {
  iss: "https://accounts.google.com",
  aud: "client-id",
  sub: "1234567890",
  email: "Alice@Gmail.com",
  email_verified: true,
  nonce: "n-1",
  exp: NOW.getTime() / 1000 + 3600,
};

function client(reply: () => Response) {
  const forms: URLSearchParams[] = [];
  const google = googleApi({
    clientId: "client-id",
    clientSecret: "client-secret",
    callbackUrl: "https://seekcloud.test/api/auth/google/callback",
    now: () => NOW,
    fetch: (async (_url: unknown, init?: RequestInit) => {
      forms.push(new URLSearchParams(init?.body as URLSearchParams));
      return reply();
    }) as typeof fetch,
  });
  return { google, forms };
}

const tokenReply = (claims: Record<string, unknown>) => () =>
  Response.json({ id_token: idToken(claims), access_token: "ya29" });

describe("Google 登录", () => {
  it("授权地址：要 openid 和 email，带 state、nonce 和 PKCE（S256）", () => {
    const { google } = client(tokenReply(good));
    const url = new URL(google.authorizeUrl({ state: "s", nonce: "n", codeChallenge: "c" }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-id",
      redirect_uri: "https://seekcloud.test/api/auth/google/callback",
      response_type: "code",
      scope: "openid email",
      state: "s",
      nonce: "n",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
  });

  it("换令牌时带上 PKCE 的 verifier；返回的邮箱统一成小写", async () => {
    const { google, forms } = client(tokenReply(good));

    const claims = await google.exchangeCode("auth-code", "verifier");

    expect(Object.fromEntries(forms[0] as URLSearchParams)).toEqual({
      code: "auth-code",
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uri: "https://seekcloud.test/api/auth/google/callback",
      grant_type: "authorization_code",
      code_verifier: "verifier",
    });
    expect(claims).toEqual({
      subject: "1234567890",
      email: "alice@gmail.com",
      emailVerified: true,
      nonce: "n-1",
    });
  });

  it.each([
    ["签发方不对", { ...good, iss: "https://evil.example.com" }],
    ["受众是别的应用", { ...good, aud: "someone-else" }],
    ["过期了", { ...good, exp: NOW.getTime() / 1000 - 3600 }],
    ["没有用户 ID", { ...good, sub: undefined }],
  ])("%s：拒绝", async (_name, claims) => {
    const { google } = client(tokenReply(claims));
    await expect(google.exchangeCode("auth-code", "verifier")).rejects.toThrow();
  });

  it("邮箱没确认过：照实返回，由调用方拒绝", async () => {
    const { google } = client(tokenReply({ ...good, email_verified: false }));
    expect((await google.exchangeCode("c", "v")).emailVerified).toBe(false);
  });

  it("Google 拒绝换令牌（比如授权码用过了）：抛错", async () => {
    const { google } = client(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(google.exchangeCode("c", "v")).rejects.toThrow("invalid_grant");
  });
});
