/** 第三方授权跳回来时，地址里 ?github=、?google=、?signin= 的含义。 */

export type Provider = "github" | "google";

export const providerNames: Record<Provider, string> = { github: "GitHub", google: "Google" };

const messages: Record<string, (name: string) => string> = {
  failed: (name) => `${name} 授权失败，请重试。`,
  identity_taken: (name) => `该 ${name} 账号已绑定其他 SeekCloud 账户。`,
  already_linked: (name) => `当前账户已绑定其他 ${name} 账号，请先在设置中解绑。`,
  unverified_email: (name) => `该 ${name} 账号的邮箱尚未验证，无法用于登录。`,
  unavailable: (name) => `${name} 登录暂不可用。`,
};

export interface AuthResult {
  /**
   * pending：陌生的第三方账号，要选创建新账户还是绑定已有账户；
   * notice：出了问题（红色提示）；info：告知一件事（比如账户已删除，普通提示）。
   */
  kind: "pending" | "notice" | "info";
  message?: string;
}

/** 读出并清掉地址里的结果参数，免得刷新页面时又出现一次。 */
export function takeAuthResult(): AuthResult | null {
  const params = new URLSearchParams(window.location.search);
  const signin = params.get("signin");
  const provider = (["github", "google"] as const).find((p) => params.has(p));
  if (!signin && !provider) return null;
  window.history.replaceState(null, "", window.location.pathname);
  if (signin === "pending") return { kind: "pending" };
  if (signin === "deleted") {
    return {
      kind: "info",
      message: "账户已删除。相关数据将在 15 天内彻底清除，该邮箱可重新注册。",
    };
  }
  const result = provider ? params.get(provider) : null;
  const message = provider && result ? messages[result]?.(providerNames[provider]) : undefined;
  return message ? { kind: "notice", message } : null;
}
