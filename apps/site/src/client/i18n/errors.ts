import type { ApiError } from "../api";
import { t, tAny } from "./index";
import { zh } from "./zh";

/**
 * 接口出错时给人看的话（#134 的"接口错误"）：认得的 code 用文案目录里写好的（按界面语言），
 * 不认得的用主站给的 message 兜底。目录里写成空字符串的（中文的 invalid_request 这类）也用主站给的：
 * 主站的说明里带着具体哪一项不对，比概括的一句有用；英文目录里是概括的一句。
 */
export function errorText(error: Pick<ApiError, "code" | "message" | "retryAfter">): string {
  if (error.code === "rate_limited" && error.retryAfter) {
    return t("error.rate_limited", { count: error.retryAfter });
  }
  const key = `error.${error.code}`;
  if (key in zh && key !== "error.rate_limited") {
    const text = tAny(key);
    if (text) return text;
  }
  return error.message;
}
