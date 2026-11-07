import type { Context } from "hono";
import { apiError } from "./errors";
import type { Clock } from "./ports";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export interface Rule {
  key: string;
  limit: number;
  windowMs: number;
}

/**
 * 滑动窗口计数，存在内存里。主站只有一个进程，重启后计数清零可以接受。
 * take 一步完成"能不能做"和"记一次"，中间没有 await，同时到达的请求不会一起漏过去。
 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #hits = new Map<string, number[]>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** 每条规则都没到上限就各记一次，返回 0；否则什么都不记，返回还要等几秒。 */
  take(rules: Rule[]): number {
    const now = this.#clock.now().getTime();
    let waitMs = 0;
    for (const rule of rules) {
      const recent = this.#recent(rule, now);
      if (recent.length >= rule.limit) {
        const oldest = recent[recent.length - rule.limit] as number;
        waitMs = Math.max(waitMs, oldest + rule.windowMs - now);
      }
    }
    if (waitMs > 0) return Math.ceil(waitMs / 1000);
    for (const rule of rules) this.#recent(rule, now).push(now);
    return 0;
  }

  /** 退回最近一次 take 记下的次数，比如密码输对了、不算输错时。 */
  release(rules: Rule[]): void {
    for (const rule of rules) this.#hits.get(storageKey(rule))?.pop();
  }

  #recent(rule: Rule, now: number): number[] {
    const id = storageKey(rule);
    const recent = (this.#hits.get(id) ?? []).filter((t) => t > now - rule.windowMs);
    this.#hits.set(id, recent);
    return recent;
  }
}

// 同一个 key 可以有几条窗口不同的规则（每分钟 1 次、每小时 5 次），各自计数。
function storageKey(rule: Rule): string {
  return `${rule.key}@${rule.windowMs}`;
}

/**
 * 部署时只有一层反向代理，它把看到的客户端地址追加到 X-Forwarded-For 的最后。
 * 前面的值客户端自己可以随便填，所以只认最后一个。直接访问时没有这个头。
 */
export function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

/** 超过频率限制时的响应：429，带 Retry-After。 */
export function tooFrequent(c: Context, seconds: number) {
  c.header("retry-after", String(seconds));
  return c.json(apiError("rate_limited", `操作过于频繁，请 ${seconds} 秒后重试`), 429);
}
