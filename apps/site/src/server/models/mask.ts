/**
 * 已保存的 key 的脱敏预览，照 dsh（dsh-credentials-local 的 maskCredential）：保留第一个 - 或 _ 之前的标识
 * （连同这个符号），加上后面的前五个、整串的后四个字符，中间至少要藏八个；不够就整串都显示成点。
 * 按 Unicode 码点算，长度和原来一样。
 */
export function maskKey(value: string): string {
  const chars = Array.from(value);
  const providerEnd = chars.findIndex((char) => char === "-" || char === "_") + 1;
  const hidden = chars.length - providerEnd - 5 - 4;
  return hidden < 8
    ? "•".repeat(chars.length)
    : `${chars.slice(0, providerEnd + 5).join("")}${"•".repeat(hidden)}${chars.slice(-4).join("")}`;
}

/**
 * 报错里认得出来的密钥打码（获取可用模型、测试连接的报错可能把 key 的片段带回来）：
 * 常见格式的 key（sk-…、AIza…、Bearer 后面的、长串的十六进制或 base64）和这次用的 key 本身。
 */
export function redactSecrets(text: string, ...known: Array<string | undefined>): string {
  let out = text;
  for (const key of known) {
    if (key && key.length >= 6) out = out.split(key).join(maskKey(key));
  }
  return out
    .replace(/\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}/g, (m) => maskKey(m))
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, (m) => maskKey(m))
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_m, p: string) => `${p}••••••••`)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => maskKey(m));
}
