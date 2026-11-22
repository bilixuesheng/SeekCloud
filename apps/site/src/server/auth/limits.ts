import type { Context } from "hono";
import { networkOf } from "../access-log";
import { clientIp, HOUR, type RateLimiter } from "../rate-limit";

/**
 * 输密码、输两步验证的验证码共用的频率限制：同一个来源一小时最多输错 10 次，之后输对的也要等；输对的不算。
 * 先占一次再核对：同时到达的请求加起来也只能试 10 次。wait 是被限制时还要等的秒数。
 */
export async function limited<T>(
  limiter: RateLimiter,
  c: Context,
  check: () => Promise<T | undefined>,
): Promise<{ wait: number; value?: T }> {
  // IPv6 按 /64 算一个来源：一个用户手里通常有一整个 /64，按单个地址限等于没限。
  const rules = [{ key: `password-ip:${networkOf(clientIp(c))}`, limit: 10, windowMs: HOUR }];
  const wait = limiter.take(rules);
  if (wait > 0) return { wait };
  const value = await check();
  if (value) limiter.release(rules);
  return { wait: 0, value };
}
