// 生成 SeekCloud 账号给提交签名用的密钥（已经有了就不重新生成），并打印公钥。
// 用法：pnpm --filter @seekcloud/host signing-key <私钥文件路径>
// 打印出来的那一行，加到 SeekCloud 专用 GitHub 账号的 Settings → SSH and GPG keys → New SSH key，
// 类型选 Signing Key。私钥只留在宿主机上。
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadSigningKey } from "../signing/sshsig";

const path = process.argv[2];
if (!path) {
  console.error("用法：pnpm --filter @seekcloud/host signing-key <私钥文件路径>");
  process.exit(1);
}
if (!existsSync(path)) {
  const pem = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  writeFileSync(path, pem, { mode: 0o600 });
  console.error(`已生成签名私钥：${path}`);
}
console.log(loadSigningKey(readFileSync(path, "utf8"), "seekcloud").publicLine);
