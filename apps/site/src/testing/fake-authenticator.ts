import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { TEST_PUBLIC_URL } from "./test-app";

/**
 * 假的通行密钥认证器（#100 的测试用）：像手机、电脑里的认证器一样生成 P-256 密钥，按 WebAuthn 的格式
 * 交回注册和登录的结果（attestation 是 none）。参数是主站给的 JSON，结果是浏览器交回主站的 JSON。
 */

/** 最小的 CBOR 编码：认证器的数据只用到整数、字节串、文本和映射。 */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Map) {
    const parts: Buffer[] = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error(`cbor 不支持：${typeof value}`);
}

const b64url = (b: Buffer) => b.toString("base64url");

interface Credential {
  id: Buffer;
  privateKey: KeyObject;
  userHandle: string;
  counter: number;
}

export class FakeAuthenticator {
  readonly credentials: Credential[] = [];

  constructor(readonly origin = TEST_PUBLIC_URL) {}

  /** 用户验证过（指纹、面容）时 flags 带 UV。 */
  #authData(rpId: string, flags: number, counter: number, attested?: Buffer): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([
      createHash("sha256").update(rpId).digest(),
      Buffer.from([flags]),
      count,
      ...(attested ? [attested] : []),
    ]);
  }

  #clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** navigator.credentials.create：新建一个 P-256 的通行密钥。 */
  register(
    options: { challenge: string; rp: { id?: string }; user: { id: string } },
    { userVerified = true, origin = this.origin }: { userVerified?: boolean; origin?: string } = {},
  ) {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const coseKey = cbor(
      new Map<number, number | Buffer>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
    const id = randomBytes(16);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, id, coseKey]);
    // UP(0x01) | UV(0x04) | AT(0x40)
    const authData = this.#authData(rpId, 0x41 | (userVerified ? 0x04 : 0), 0, attested);
    const attestationObject = cbor(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    this.credentials.push({ id, privateKey, userHandle: options.user.id, counter: 0 });
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(this.#clientData("webauthn.create", options.challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get：用某个通行密钥（默认最后添加的）签名。 */
  authenticate(
    options: { challenge: string; rpId?: string },
    {
      credential = this.credentials.at(-1),
      userVerified = true,
      origin = this.origin,
    }: { credential?: Credential; userVerified?: boolean; origin?: string } = {},
  ) {
    if (!credential) throw new Error("假认证器里还没有通行密钥");
    const rpId = options.rpId ?? new URL(origin).hostname;
    credential.counter += 1;
    const authData = this.#authData(rpId, 0x01 | (userVerified ? 0x04 : 0), credential.counter);
    const clientData = this.#clientData("webauthn.get", options.challenge, origin);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
      credential.privateKey,
    );
    return {
      id: b64url(credential.id),
      rawId: b64url(credential.id),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
