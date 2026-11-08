import type { ErrorCode, SafeError } from "@seekcloud/protocol";

const messages: Record<ErrorCode, string> = {
  model_unavailable: "模型服务暂时不可用",
  model_rate_limited: "模型服务繁忙，请稍后重试",
  model_rejected: "模型服务拒绝了本次请求",
  context_too_long: "对话长度超出模型上限",
  timeout: "模型服务响应超时",
  sandbox_unavailable: "沙箱暂时无法创建",
  repo_clone_failed: "克隆仓库失败",
  internal: "服务内部错误",
};

/**
 * 错误给用户看的样子：一句说明，后面括号里是状态码和参考号（ADR 0007）。
 * 用户报问题时给出参考号，我们去宿主机日志里查原始报错。
 */
export function errorText(error: SafeError): string {
  const extra = [
    error.status === undefined ? undefined : String(error.status),
    error.ref === undefined ? undefined : `参考号 ${error.ref}`,
  ].filter(Boolean);
  const text = messages[error.code] ?? messages.internal;
  return extra.length > 0 ? `${text}（${extra.join(" · ")}）` : text;
}
