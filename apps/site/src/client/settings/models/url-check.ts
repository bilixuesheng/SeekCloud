import { api } from "../../api";
import { MODEL_PROVIDERS } from "./types";

/**
 * 保存前看一下接口地址（#113 的安全要求）：不是 HTTPS 时提示明文，解析到内网时提示在内网。
 * 自己部署的模型可以是内网地址，只提示不拦。检查失败（地址格式不对这些）时不提示，由保存时的校验报错。
 */
export async function urlWarnings(url: string): Promise<string[]> {
  try {
    const res = await api<{ plaintext: boolean; internal: boolean }>(
      `${MODEL_PROVIDERS}/check-url`,
      { url },
    );
    return [
      ...(res.plaintext ? ["该地址不是 HTTPS，请求和密钥将以明文发往该地址。"] : []),
      ...(res.internal ? ["该地址在内网或本机。"] : []),
    ];
  } catch {
    return [];
  }
}
