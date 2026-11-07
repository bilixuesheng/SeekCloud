import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";

/**
 * 代理自己的 CA：用来解密沙箱发往 GitHub 的 HTTPS 请求。
 * CA 证书放进沙箱的信任列表；CA 私钥只在宿主机上。用 openssl 生成，保存在 dir 里，重启后沿用。
 */
export class ProxyCa {
  readonly certPem: string;
  readonly #dir: string;
  readonly #contexts = new Map<string, SecureContext>();

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = join(dir, "ca.key");
    const cert = join(dir, "ca.crt");
    if (!existsSync(cert)) {
      openssl([
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "3650",
        "-subj",
        "/CN=SeekCloud Sandbox Proxy CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
      ]);
    }
    this.certPem = readFileSync(cert, "utf8");
  }

  /** 给某个域名签一张证书（缓存在内存里）。 */
  contextFor(host: string): SecureContext {
    const cached = this.#contexts.get(host);
    if (cached) return cached;
    const base = join(this.#dir, host.replace(/[^a-z0-9.-]/gi, "_"));
    const ext = `${base}.ext`;
    writeFileSync(ext, `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\n`);
    openssl([
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      `${base}.key`,
      "-out",
      `${base}.csr`,
      "-subj",
      `/CN=${host}`,
    ]);
    openssl([
      "x509",
      "-req",
      "-in",
      `${base}.csr`,
      "-CA",
      join(this.#dir, "ca.crt"),
      "-CAkey",
      join(this.#dir, "ca.key"),
      "-CAcreateserial",
      "-out",
      `${base}.crt`,
      "-days",
      "397",
      "-extfile",
      ext,
    ]);
    const context = createSecureContext({
      key: readFileSync(`${base}.key`),
      cert: readFileSync(`${base}.crt`),
    });
    this.#contexts.set(host, context);
    return context;
  }
}

function openssl(args: string[]) {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}
