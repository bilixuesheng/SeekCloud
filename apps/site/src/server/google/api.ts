import { type Google, type GoogleClaims, GoogleError } from "./port";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

interface IdTokenPayload {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean | string;
  nonce?: string;
}

/**
 * 真的 Google。ID 令牌是主站直接从 Google 的令牌接口（HTTPS）拿到的，
 * 按 OpenID Connect 的规定可以不验签名，但签发方、受众和有效期一定要查。
 */
export function googleApi(options: {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): Google {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  return {
    configured: true,
    authorizeUrl({ state, nonce, codeChallenge }) {
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: options.callbackUrl,
        response_type: "code",
        scope: "openid email",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return url.toString();
    },
    async exchangeCode(code, codeVerifier): Promise<GoogleClaims> {
      const res = await send(TOKEN, {
        method: "POST",
        body: new URLSearchParams({
          code,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          redirect_uri: options.callbackUrl,
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch((error: Error) => {
        throw new GoogleError(`连不上 Google：${error.message}`);
      });
      const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
      if (!res.ok || !body.id_token) {
        throw new GoogleError(`Google 换令牌失败：${res.status} ${body.error ?? ""}`.trim());
      }
      const payload = decodePayload(body.id_token);
      if (!payload.iss || !ISSUERS.includes(payload.iss)) throw new GoogleError("签发方不对");
      if (payload.aud !== options.clientId) throw new GoogleError("受众不对");
      if (!payload.exp || payload.exp * 1000 < now().getTime() - 60_000) {
        throw new GoogleError("ID 令牌过期了");
      }
      if (!payload.sub || !payload.email) throw new GoogleError("ID 令牌缺少用户信息");
      return {
        subject: payload.sub,
        email: payload.email.trim().toLowerCase(),
        emailVerified: payload.email_verified === true || payload.email_verified === "true",
        nonce: payload.nonce,
      };
    },
  };
}

function decodePayload(jwt: string): IdTokenPayload {
  const part = jwt.split(".")[1];
  if (!part) throw new GoogleError("ID 令牌格式不对");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as IdTokenPayload;
  } catch {
    throw new GoogleError("ID 令牌格式不对");
  }
}
