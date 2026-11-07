import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDeps } from "../app";
import { finishThirdPartySignIn, type NextPage, parseNext, randomToken } from "../auth/third-party";
import type { GitHubTokens } from "./port";

const STATE_COOKIE = "sc_gh_state";
const COOKIE_PATH = "/api/auth/github";
const TEN_MINUTES = 600;

/** 点"用 GitHub 登录"或"关联 GitHub"：记下 state 和回到哪一页，跳到 GitHub 授权。 */
export function startGitHubSignIn(deps: AppDeps, c: Context): string {
  const state = randomToken();
  const next = parseNext(c.req.query("next"));
  setCookie(c, STATE_COOKIE, `${state}|${next}`, {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.secureCookies,
    path: COOKIE_PATH,
    maxAge: TEN_MINUTES,
  });
  return deps.github.authorizeUrl(state);
}

/** GitHub 授权后跳回来。返回接下来要跳到的页面。 */
export async function finishGitHubSignIn(deps: AppDeps, c: Context): Promise<string> {
  const [state, nextValue] = (getCookie(c, STATE_COOKIE) ?? "").split("|");
  deleteCookie(c, STATE_COOKIE, { path: COOKIE_PATH });
  const next: NextPage = parseNext(nextValue);
  const code = c.req.query("code");
  if (!state || !code || c.req.query("state") !== state) return "/?github=failed";

  let tokens: GitHubTokens;
  let github: { id: string; login: string };
  let email: string | undefined;
  try {
    tokens = await deps.github.exchangeCode(code);
    github = await deps.github.getUser(tokens.accessToken);
    email = await deps.github.getPrimaryEmail(tokens.accessToken);
  } catch (error) {
    console.error("GitHub 授权失败", error);
    return "/?github=failed";
  }

  return finishThirdPartySignIn(
    deps,
    c,
    {
      provider: "github",
      subject: github.id,
      login: github.login,
      email: email ?? null,
      githubTokens: tokens,
    },
    next,
  );
}
