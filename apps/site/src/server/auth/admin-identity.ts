import { apiError, notLoggedIn } from "../errors";
import type { Identity } from "../ports";
import { RateLimiter } from "../rate-limit";
import { hasAdmin } from "./admin";
import { authRoutes } from "./admin-routes";
import { currentUser, type LoginDeps } from "./login-sessions";

/**
 * 主干的身份来源：只有一个管理员，用密码登录（ADR 0008）。登录状态放在 Cookie 里，
 * 库里只存它的哈希（login_sessions）。
 */
export function adminIdentity(deps: LoginDeps): Identity {
  // 输错密码的计数：同一个 IP 一小时最多 10 次。
  const limiter = new RateLimiter(deps.clock);
  return {
    currentUser: (c) => currentUser(deps, c),
    loggedOut: async () =>
      (await hasAdmin(deps.db)) ? notLoggedIn : apiError("setup_required", "请先设置管理员密码"),
    routes: authRoutes(deps, limiter),
  };
}
