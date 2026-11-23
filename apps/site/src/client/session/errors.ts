import type { ErrorCode, SafeError } from "@seekcloud/protocol";
import { type PlainKey, t } from "../i18n";

const messages: Record<ErrorCode, PlainKey> = {
  model_unavailable: "agentError.model_unavailable",
  model_rate_limited: "agentError.model_rate_limited",
  model_rejected: "agentError.model_rejected",
  context_too_long: "agentError.context_too_long",
  timeout: "agentError.timeout",
  sandbox_unavailable: "agentError.sandbox_unavailable",
  repo_clone_failed: "agentError.repo_clone_failed",
  internal: "agentError.internal",
};

/**
 * 错误给用户看的样子：一句说明，后面括号里是状态码和参考号（ADR 0007）。
 * 用户报问题时给出参考号，我们去宿主机日志里查原始报错。
 */
export function errorText(error: SafeError): string {
  const extra = [
    error.status === undefined ? undefined : String(error.status),
    error.ref === undefined ? undefined : t("agentError.ref", { ref: error.ref }),
  ].filter(Boolean);
  const text = t(messages[error.code] ?? messages.internal);
  return extra.length > 0 ? t("agentError.withDetail", { text, detail: extra.join(" · ") }) : text;
}
