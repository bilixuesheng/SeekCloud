import { type PlainKey, t } from "./i18n";

/** 关联 GitHub 跳回来时，地址里 ?github= 的含义。 */
const messages: Record<string, PlainKey> = {
  failed: "github.authFailed",
};

/** 读出并清掉地址里的结果参数，免得刷新页面时又出现一次。返回结果（认得的），提示的话用 authResultText 取。 */
export function takeAuthResult(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("github");
  if (result === null) return undefined;
  window.history.replaceState(null, "", window.location.pathname);
  return result in messages ? result : undefined;
}

/** 结果要提示的话（按当前的界面语言，换了语言跟着换）。 */
export const authResultText = (result: string | undefined): string | undefined => {
  const key = result === undefined ? undefined : messages[result];
  return key ? t(key) : undefined;
};
