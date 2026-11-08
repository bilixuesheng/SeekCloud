import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDeps } from "../app";
import { currentUser } from "../auth/login-sessions";
import type { GitHubTokens } from "./port";
import { connectGitHub } from "./tokens";

const STATE_COOKIE = "sc_gh_state";
const COOKIE_PATH = "/api/auth/github";
const TEN_MINUTES = 600;

/** 授权完成后可以回到的页面。只接受这几个，免得被拿去跳到别的网站。 */
const NEXT_PAGES = ["/", "/settings"] as const;
const parseNext = (value: string | undefined) => NEXT_PAGES.find((page) => page === value) ?? "/";

/** 点"关联 GitHub"：记下 state 和回到哪一页，跳到 GitHub 授权。 */
export function startGitHubLink(deps: AppDeps, c: Context): string {
  const state = randomBytes(24).toString("base64url");
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

/** GitHub 授权后跳回来：把 GitHub 账号关联到管理员。返回接下来要跳到的页面。 */
export async function finishGitHubLink(deps: AppDeps, c: Context): Promise<string> {
  const [state, next] = (getCookie(c, STATE_COOKIE) ?? "").split("|");
  deleteCookie(c, STATE_COOKIE, { path: COOKIE_PATH });
  const code = c.req.query("code");
  if (!state || !code || c.req.query("state") !== state) return "/?github=failed";
  // GitHub 不是登录方式：授权途中登录状态过期了，就不关联。
  const me = await currentUser(deps, c);
  if (!me) return "/?github=failed";

  let tokens: GitHubTokens;
  let login: string;
  try {
    tokens = await deps.github.exchangeCode(code);
    ({ login } = await deps.github.getUser(tokens.accessToken));
  } catch (error) {
    console.error("GitHub 授权失败", error);
    return "/?github=failed";
  }
  // 令牌留在主站（ADR 0003），不经过浏览器。
  await connectGitHub(deps, me.id, login, tokens);
  return parseNext(next);
}
