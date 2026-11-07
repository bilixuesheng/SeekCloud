/** 关联 GitHub 跳回来时，地址里 ?github= 的含义。 */
const messages: Record<string, string> = {
  failed: "GitHub 授权失败，请重试。",
};

/** 读出并清掉地址里的结果参数，免得刷新页面时又出现一次。返回要提示的话。 */
export function takeAuthResult(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("github");
  if (result === null) return undefined;
  window.history.replaceState(null, "", window.location.pathname);
  return messages[result];
}
