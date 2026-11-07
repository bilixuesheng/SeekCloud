import type { HumanCheck, HumanCheckAction, HumanCheckResult } from "../server/human-check";

/** 假的人机验证：tokenFor(操作) 给出的令牌只对那个操作有效；down() 模拟主站连不上 Cloudflare。 */
export class FakeHumanCheck implements HumanCheck {
  readonly siteKey = "test-site-key";
  readonly calls: Array<{ token: string | undefined; action: HumanCheckAction; ip: string }> = [];
  #down = false;

  /** 浏览器从 Turnstile 拿到的令牌。 */
  tokenFor(action: HumanCheckAction): string {
    return `ok:${action}`;
  }

  down(): void {
    this.#down = true;
  }

  up(): void {
    this.#down = false;
  }

  async verify(
    token: string | undefined,
    request: { action: HumanCheckAction; ip: string },
  ): Promise<HumanCheckResult> {
    this.calls.push({ token, ...request });
    if (!token) return "failed";
    if (this.#down) return "unavailable";
    return token === this.tokenFor(request.action) ? "passed" : "failed";
  }
}
