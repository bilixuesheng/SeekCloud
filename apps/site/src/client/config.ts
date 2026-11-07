import { api } from "./api";

export interface ClientConfig {
  /** Turnstile 的站点密钥；null 表示不做人机验证。 */
  turnstileSiteKey: string | null;
  googleLogin: boolean;
}

const fallback: ClientConfig = { turnstileSiteKey: null, googleLogin: false };
let promise: Promise<ClientConfig> | undefined;

/** 浏览器需要的公开配置，整个页面只取一次。 */
export function clientConfig(): Promise<ClientConfig> {
  promise ??= api<ClientConfig>("/api/client-config").catch(() => fallback);
  return promise;
}
