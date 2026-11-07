import { createHash } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDeps } from "../app";
import { finishThirdPartySignIn, parseNext, randomToken } from "../auth/third-party";
import type { GoogleClaims } from "./port";

const COOKIE = "sc_google";
const COOKIE_PATH = "/api/auth/google";
const TEN_MINUTES = 600;

/** 点"用 Google 继续"或"绑定 Google"：记下 state、nonce、PKCE 和回到哪一页，跳到 Google 授权。 */
export function startGoogleSignIn(deps: AppDeps, c: Context): string {
  if (!deps.google.configured) return "/?google=unavailable";
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const next = parseNext(c.req.query("next"));
  setCookie(c, COOKIE, [state, nonce, verifier, next].join("|"), {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.secureCookies,
    path: COOKIE_PATH,
    maxAge: TEN_MINUTES,
  });
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  return deps.google.authorizeUrl({ state, nonce, codeChallenge });
}

/** Google 授权后跳回来。返回接下来要跳到的页面。 */
export async function finishGoogleSignIn(deps: AppDeps, c: Context): Promise<string> {
  const [state, nonce, verifier, nextValue] = (getCookie(c, COOKIE) ?? "").split("|");
  deleteCookie(c, COOKIE, { path: COOKIE_PATH });
  const code = c.req.query("code");
  if (!state || !nonce || !verifier || !code || c.req.query("state") !== state) {
    return "/?google=failed";
  }

  let claims: GoogleClaims;
  try {
    claims = await deps.google.exchangeCode(code, verifier);
  } catch (error) {
    console.error("Google 授权失败", error);
    return "/?google=failed";
  }
  // nonce 对不上：ID 令牌不是这次授权拿到的（被人换过）。
  if (claims.nonce !== nonce) return "/?google=failed";
  if (!claims.emailVerified) return "/?google=unverified_email";

  return finishThirdPartySignIn(
    deps,
    c,
    { provider: "google", subject: claims.subject, login: claims.email, email: claims.email },
    parseNext(nextValue),
  );
}
