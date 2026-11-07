import { apiError } from "./errors";

/**
 * 人机验证防的操作。浏览器拿到的令牌和操作绑定：发验证码的令牌不能拿去注册。
 */
export const HUMAN_CHECK_ACTIONS = ["send_code", "signup"] as const;
export type HumanCheckAction = (typeof HUMAN_CHECK_ACTIONS)[number];

/** passed：通过；failed：没通过（令牌无效、过期、用过了、操作不对）；unavailable：主站连不上 Cloudflare。 */
export type HumanCheckResult = "passed" | "failed" | "unavailable";

export interface HumanCheck {
  /** 给浏览器的站点密钥。null 表示没配，不验证（开发和测试）。 */
  readonly siteKey: string | null;
  verify(
    token: string | undefined,
    request: { action: HumanCheckAction; ip: string },
  ): Promise<HumanCheckResult>;
}

/** 没配 Turnstile 时用：什么都放行。 */
export const noHumanCheck: HumanCheck = {
  siteKey: null,
  verify: async () => "passed",
};

export const humanCheckErrors = {
  failed: apiError("human_check_failed", "人机验证未通过，请刷新页面后重试"),
  unavailable: apiError("human_check_unavailable", "人机验证服务暂时不可用，请稍后注册"),
};

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  "error-codes"?: string[];
  metadata?: { result_with_testing_key?: boolean };
}

/** Cloudflare Turnstile：拿浏览器给的令牌去 Cloudflare 校验。 */
export function turnstile(options: {
  siteKey: string;
  secretKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): HumanCheck {
  const send = options.fetch ?? fetch;
  return {
    siteKey: options.siteKey,
    async verify(token, { action, ip }) {
      if (!token) return "failed";
      const form = new URLSearchParams({ secret: options.secretKey, response: token });
      if (ip !== "unknown") form.set("remoteip", ip);
      let data: SiteverifyResponse;
      try {
        const res = await send(SITEVERIFY, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = (await res.json()) as SiteverifyResponse;
      } catch (error) {
        console.error(`人机验证：连不上 Cloudflare（${(error as Error).message}）`);
        return "unavailable";
      }
      const errors = data["error-codes"] ?? [];
      if (errors.includes("internal-error")) return "unavailable";
      // 我们自己的密钥配错了：不能因此把所有人都挡在外面，按连不上处理，并在日志里报出来。
      if (errors.some((code) => code.includes("input-secret"))) {
        console.error(`人机验证：TURNSTILE_SECRET_KEY 不对（${errors.join(", ")}），请检查配置`);
        return "unavailable";
      }
      if (data.success !== true) return "failed";
      // 令牌必须是为这个操作拿的。Cloudflare 的测试密钥不带 action，只在开发时用得到。
      if (data.action !== action && !data.metadata?.result_with_testing_key) return "failed";
      return "passed";
    },
  };
}
