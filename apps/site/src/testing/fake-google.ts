import { createHash } from "node:crypto";
import type { Google, GoogleClaims } from "../server/google/port";
import { GoogleError } from "../server/google/port";

export interface FakeGoogleUser {
  subject: string;
  email: string;
  emailVerified: boolean;
}

/**
 * 内存里的假 Google。authorize(用户, 授权地址) 模拟用户在 Google 上点了同意，返回授权码；
 * 换令牌时和真的一样检查 PKCE，并把授权地址里的 nonce 放进声明。
 */
export class FakeGoogle implements Google {
  readonly configured = true;
  #next = 1;
  readonly #codes = new Map<
    string,
    { user: FakeGoogleUser; nonce: string | null; challenge: string | null }
  >();

  addUser(user: { email: string; emailVerified?: boolean }): FakeGoogleUser {
    return {
      subject: `g-${this.#next++}`,
      email: user.email,
      emailVerified: user.emailVerified ?? true,
    };
  }

  authorizeUrl({
    state,
    nonce,
    codeChallenge,
  }: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }) {
    const params = new URLSearchParams({ state, nonce, code_challenge: codeChallenge });
    return `https://accounts.google.test/auth?${params}`;
  }

  /** 用户在 Google 上同意授权。nonce 可以改掉，模拟被替换过的回调。 */
  authorize(user: FakeGoogleUser, authorizeUrl: string, override: { nonce?: string } = {}): string {
    const params = new URL(authorizeUrl).searchParams;
    const code = `gcode-${this.#next++}`;
    this.#codes.set(code, {
      user,
      nonce: override.nonce ?? params.get("nonce"),
      challenge: params.get("code_challenge"),
    });
    return code;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<GoogleClaims> {
    const grant = this.#codes.get(code);
    this.#codes.delete(code);
    if (!grant) throw new GoogleError("授权码无效");
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    if (challenge !== grant.challenge) throw new GoogleError("PKCE 校验失败");
    return {
      subject: grant.user.subject,
      email: grant.user.email,
      emailVerified: grant.user.emailVerified,
      nonce: grant.nonce ?? undefined,
    };
  }
}
