/** Google 登录（OpenID Connect，授权码流程 + PKCE）。主站对 Google 的所有调用都经过这里，测试里换成假的。 */
export interface Google {
  /** 没配 Google 的密钥时为 false：登录页不显示 Google 按钮。 */
  readonly configured: boolean;
  /** 跳去 Google 授权的地址。nonce 会原样出现在 ID 令牌里；codeChallenge 是 PKCE 的 S256 摘要。 */
  authorizeUrl(request: { state: string; nonce: string; codeChallenge: string }): string;
  /** 用授权码换 ID 令牌，校验签发方、受众和有效期，返回里面的声明。失败时抛出 GoogleError。 */
  exchangeCode(code: string, codeVerifier: string): Promise<GoogleClaims>;
}

export interface GoogleClaims {
  /** Google 账号不会变的 ID。 */
  subject: string;
  email: string;
  /** Google 是否确认过这个邮箱属于这个人。 */
  emailVerified: boolean;
  nonce: string | undefined;
}

export class GoogleError extends Error {}

/** 没配 Google 时用。 */
export const unconfiguredGoogle: Google = {
  configured: false,
  authorizeUrl: () => {
    throw new GoogleError("没有配置 Google 登录");
  },
  exchangeCode: () => Promise.reject(new GoogleError("没有配置 Google 登录")),
};
