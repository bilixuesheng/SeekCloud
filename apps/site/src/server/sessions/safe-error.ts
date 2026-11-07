import { ERROR_CODES, type ErrorCode, type SafeError } from "@seekcloud/protocol";

const REF = /^[A-Za-z0-9-]{1,32}$/;

/**
 * 宿主机报上来的错误，只留下白名单里的三样：类别、状态码、参考号（ADR 0007）。
 * 宿主机的代码就算出了错、多带了上游的原始报错，也到不了用户那里：
 * 不认识的类别算内部错误，不像样的状态码和参考号直接丢掉。
 */
export function toSafeError(input: unknown): SafeError {
  const raw: Record<string, unknown> =
    typeof input === "object" && input !== null ? { ...input } : {};
  const code = ERROR_CODES.find((c): c is ErrorCode => c === raw.code) ?? "internal";
  const error: SafeError = { code };
  if (typeof raw.status === "number" && Number.isInteger(raw.status)) {
    if (raw.status >= 400 && raw.status <= 599) error.status = raw.status;
  }
  if (typeof raw.ref === "string" && REF.test(raw.ref)) error.ref = raw.ref;
  return error;
}
