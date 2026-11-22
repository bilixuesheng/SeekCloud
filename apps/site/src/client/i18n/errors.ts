import type { ApiError } from "../api";
import { t, tAny } from "./index";
import { zh } from "./zh";

/**
 * 接口出错时给人看的话（#134 的"接口错误"）：认得的 code 用文案目录里写好的（按界面语言），
 * 不认得的用主站给的 message 兜底。
 */
export function errorText(error: Pick<ApiError, "code" | "message" | "retryAfter">): string {
  if (error.code === "rate_limited" && error.retryAfter) {
    return t("error.rate_limited", { count: error.retryAfter });
  }
  const key = `error.${error.code}`;
  if (key in zh && key !== "error.rate_limited") return tAny(key);
  return error.message;
}
