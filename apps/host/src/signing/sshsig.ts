import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";

// git 用 SSH 密钥签名提交时的格式（OpenSSH 的 SSHSIG，见 PROTOCOL.sshsig）。
// 宿主机自己签，不依赖 ssh-keygen；密钥只在宿主机上，沙箱里只有公钥。

/** SSH 线格式里的 string：4 字节长度加内容。 */
const sshString = (data: Buffer | string) => {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

const MAGIC = Buffer.from("SSHSIG");

export interface SigningKey {
  privateKey: KeyObject;
  /** ssh-ed25519 公钥的线格式。 */
  publicBlob: Buffer;
  /** 一行 "ssh-ed25519 AAAA… comment"：加到 SeekCloud 账号的 GitHub 签名密钥里，也放进沙箱给 git 用。 */
  publicLine: string;
}

/** 从 PKCS#8 PEM 读 ed25519 私钥。 */
export function loadSigningKey(pem: string, comment = "seekcloud"): SigningKey {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("签名密钥必须是 ed25519");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const raw = Buffer.from(jwk.x as string, "base64url");
  const publicBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(raw)]);
  return {
    privateKey,
    publicBlob,
    publicLine: `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}`,
  };
}

/** 签名，返回 ssh-keygen -Y sign 输出的那种带头尾的文本。 */
export function sshSign(key: SigningKey, namespace: string, message: Buffer): string {
  const hash = createHash("sha512").update(message).digest();
  const signed = Buffer.concat([
    MAGIC,
    sshString(namespace),
    sshString(""),
    sshString("sha512"),
    sshString(hash),
  ]);
  const signature = Buffer.concat([
    sshString("ssh-ed25519"),
    sshString(sign(null, signed, key.privateKey)),
  ]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([
    MAGIC,
    version,
    sshString(key.publicBlob),
    sshString(namespace),
    sshString(""),
    sshString("sha512"),
    sshString(signature),
  ]);
  const lines = blob.toString("base64").match(/.{1,70}/g) ?? [];
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

/**
 * 提交者（提交对象）或打标签的人（标签对象）的邮箱。
 * 签名服务只给 SeekCloud 账号自己提交的对象签名，免得被拿去给冒充别人的提交盖"已验证"。
 */
export function gitObjectSigner(message: Buffer): string | undefined {
  const header = message.toString("utf8").split("\n\n")[0] ?? "";
  for (const line of header.split("\n")) {
    const match = /^(?:committer|tagger) .*<([^>]*)>/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** 只给 git 的提交和标签对象签名，免得签名服务被拿去签别的东西。 */
export function looksLikeGitObject(message: Buffer): boolean {
  const head = message.subarray(0, 64).toString("latin1");
  return /^tree [0-9a-f]{40,64}\n/.test(head) || /^object [0-9a-f]{40,64}\n/.test(head);
}
