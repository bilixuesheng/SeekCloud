import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAuthenticator } from "../../testing/fake-authenticator";
import { createTestApp, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";
import { accessLogs, passkeys } from "../db/schema";
import { resetAdminPassword } from "./admin";
import { relyingParty } from "./passkeys";
import { timeStep, totpCode } from "./totp";

/** 通行密钥（#100）：添加、登录、删除，用假的认证器（src/testing/fake-authenticator.ts）。 */

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

interface Options {
  challenge: string;
  rp: { id: string };
  user: { id: string };
  rpId: string;
}

describe("通行密钥", () => {
  let t: TestApp;
  let admin: TestBrowser;
  const phone = new FakeAuthenticator();

  const list = async () =>
    (await (await admin.get("/api/auth/passkeys")).json()) as {
      available: boolean;
      rpId: string | null;
      passkeys: Array<{ id: string; name: string; lastUsedAt: string | null; usable: boolean }>;
    };
  const loginOptions = async (b: TestBrowser) =>
    (await (await b.post("/api/auth/passkeys/login/options")).json()) as Options;

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.admin();
  });
  afterAll(() => t.close());

  it("能不能用：要配 PUBLIC_URL，而且是 HTTPS（本机 localhost 可以是 HTTP）", () => {
    expect(relyingParty(undefined)).toBeUndefined();
    expect(relyingParty("http://192.168.1.10:3000")).toBeUndefined();
    expect(relyingParty("not a url")).toBeUndefined();
    expect(relyingParty("http://localhost:3000")).toEqual({
      rpId: "localhost",
      origin: "http://localhost:3000",
    });
    expect(relyingParty("https://seek.example.com/")).toEqual({
      rpId: "seek.example.com",
      origin: "https://seek.example.com",
    });
  });

  it("添加：先再输一次密码拿参数（要求用户验证、可发现的通行密钥），交回认证器的结果后存下；记一条访问记录", async () => {
    expect(await list()).toEqual({ available: true, rpId: "seekcloud.test", passkeys: [] });
    const wrong = await admin.post("/api/auth/passkeys/register/options", { password: "nope" });
    expect(await errorCode(wrong)).toBe("wrong_password");

    const options = (await (
      await admin.post("/api/auth/passkeys/register/options", { password: t.adminPassword })
    ).json()) as Options & {
      authenticatorSelection: { userVerification: string; residentKey: string };
      attestation: string;
    };
    expect(options.rp.id).toBe("seekcloud.test");
    expect(options.authenticatorSelection).toMatchObject({
      userVerification: "required",
      residentKey: "required",
    });
    expect(options.attestation).toBe("none");
    const res = await admin.post("/api/auth/passkeys/register", {
      name: "我的手机",
      credential: phone.register(options),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "我的手机", usable: true, lastUsedAt: null });
    expect((await list()).passkeys.map((p) => p.name)).toEqual(["我的手机"]);
    const logged = await t.db
      .select({ id: accessLogs.id })
      .from(accessLogs)
      .where(eq(accessLogs.event, "passkey_add"));
    expect(logged).toHaveLength(1);
  });

  it("挑战值只能用一次；没验证用户、别的网站来的、过期的都不收", async () => {
    const options = (await (
      await admin.post("/api/auth/passkeys/register/options", { password: t.adminPassword })
    ).json()) as Options;
    const other = new FakeAuthenticator();
    const credential = other.register(options);
    expect(
      (await admin.post("/api/auth/passkeys/register", { name: "甲", credential })).status,
    ).toBe(201);
    // 同一个挑战值再交一次
    const replay = await admin.post("/api/auth/passkeys/register", {
      name: "乙",
      credential: new FakeAuthenticator().register(options),
    });
    expect(await errorCode(replay)).toBe("passkey_invalid");

    const noUv = await admin.post("/api/auth/passkeys/register", {
      name: "丙",
      credential: new FakeAuthenticator().register(
        (await (
          await admin.post("/api/auth/passkeys/register/options", { password: t.adminPassword })
        ).json()) as Options,
        { userVerified: false },
      ),
    });
    expect(await errorCode(noUv)).toBe("passkey_invalid");

    const phishing = await admin.post("/api/auth/passkeys/register", {
      name: "丁",
      credential: new FakeAuthenticator("https://evil.example").register(
        (await (
          await admin.post("/api/auth/passkeys/register/options", { password: t.adminPassword })
        ).json()) as Options,
      ),
    });
    expect(await errorCode(phishing)).toBe("passkey_invalid");

    const late = (await (
      await admin.post("/api/auth/passkeys/register/options", { password: t.adminPassword })
    ).json()) as Options;
    t.clock.advance(5 * 60_000 + 1000);
    expect(
      await errorCode(
        await admin.post("/api/auth/passkeys/register", {
          name: "戊",
          credential: new FakeAuthenticator().register(late),
        }),
      ),
    ).toBe("passkey_invalid");
    expect((await list()).passkeys.map((p) => p.name)).toEqual(["我的手机", "甲"]);
  });

  it("登录：通过后直接登录，不用密码；记下最后使用的时间；挑战值不能重放", async () => {
    const b = t.browser();
    const options = await loginOptions(b);
    expect(options.rpId).toBe("seekcloud.test");
    const assertion = phone.authenticate(options);
    const res = await b.post("/api/auth/passkeys/login", { credential: assertion });
    expect(res.status).toBe(204);
    expect((await b.get("/api/me")).status).toBe(200);
    expect((await list()).passkeys[0]?.lastUsedAt).not.toBeNull();

    const again = t.browser();
    expect(
      await errorCode(await again.post("/api/auth/passkeys/login", { credential: assertion })),
    ).toBe("passkey_invalid");
  });

  it("登录：没验证用户、别的网站来的、不认识的通行密钥都不行；开了两步验证也不用再输验证码；App 拿到设备令牌", async () => {
    const b = t.browser();
    const noUv = phone.authenticate(await loginOptions(b), { userVerified: false });
    expect(await errorCode(await b.post("/api/auth/passkeys/login", { credential: noUv }))).toBe(
      "passkey_invalid",
    );
    const phishing = phone.authenticate(await loginOptions(b), { origin: "https://evil.example" });
    expect(
      await errorCode(await b.post("/api/auth/passkeys/login", { credential: phishing })),
    ).toBe("passkey_invalid");
    const stranger = new FakeAuthenticator();
    stranger.register({ challenge: "x", rp: { id: "seekcloud.test" }, user: { id: "x" } });
    expect(
      await errorCode(
        await b.post("/api/auth/passkeys/login", {
          credential: stranger.authenticate(await loginOptions(b)),
        }),
      ),
    ).toBe("passkey_invalid");

    // 开两步验证
    const setup = (await (
      await admin.post("/api/auth/two-factor/setup", { password: t.adminPassword })
    ).json()) as { secret: string; setupToken: string };
    await admin.post("/api/auth/two-factor/enable", {
      setupToken: setup.setupToken,
      code: totpCode(setup.secret, timeStep(t.clock.now())),
    });
    const app = t.browser();
    const res = await app.post("/api/auth/passkeys/login", {
      credential: phone.authenticate(await loginOptions(app)),
      client: "app",
      deviceName: "Pixel 9",
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(
      (await t.browser().request("/api/me", { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(200);
    // 之后添加、删除要带验证码
    const missing = await admin.post("/api/auth/passkeys/register/options", {
      password: t.adminPassword,
    });
    expect(await errorCode(missing)).toBe("code_required");
    t.clock.advance(30_000);
    expect(
      (
        await admin.post("/api/auth/passkeys/register/options", {
          password: t.adminPassword,
          code: totpCode(setup.secret, timeStep(t.clock.now())),
        })
      ).status,
    ).toBe(200);
    t.clock.advance(30_000);
    await admin.post("/api/auth/two-factor/disable", {
      password: t.adminPassword,
      code: totpCode(setup.secret, timeStep(t.clock.now())),
    });
  });

  it("删除：要再输密码；删了就不能再用它登录；记一条访问记录", async () => {
    const [first] = (await list()).passkeys;
    const id = first?.id as string;
    const wrong = await admin.request(`/api/auth/passkeys/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(await errorCode(wrong)).toBe("wrong_password");
    const res = await admin.request(`/api/auth/passkeys/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: t.adminPassword }),
    });
    expect(res.status).toBe(204);
    expect((await list()).passkeys.map((p) => p.name)).toEqual(["甲"]);
    const b = t.browser();
    expect(
      await errorCode(
        await b.post("/api/auth/passkeys/login", {
          credential: phone.authenticate(await loginOptions(b), {
            credential: phone.credentials[0],
          }),
        }),
      ),
    ).toBe("passkey_invalid");
    const logged = await t.db
      .select({ id: accessLogs.id })
      .from(accessLogs)
      .where(eq(accessLogs.event, "passkey_remove"));
    expect(logged).toHaveLength(1);
  });

  it("重置命令删掉所有通行密钥", async () => {
    const reset = await resetAdminPassword(t.db);
    expect(reset?.passkeysRemoved).toBe(1);
  });
});

describe("没配 PUBLIC_URL 的部署", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ publicUrl: null });
  });
  afterAll(() => t.close());

  it("通行密钥用不了：列表里写明，添加和登录都回 409", async () => {
    const admin = await t.admin();
    expect(await (await admin.get("/api/auth/passkeys")).json()).toEqual({
      available: false,
      rpId: null,
      passkeys: [],
    });
    const add = await admin.post("/api/auth/passkeys/register/options", {
      password: t.adminPassword,
    });
    expect(add.status).toBe(409);
    expect(await errorCode(add)).toBe("passkeys_unavailable");
    expect((await t.browser().post("/api/auth/passkeys/login/options")).status).toBe(409);
  });
});

describe("主站换了地址", () => {
  it("旧地址上添加的通行密钥标成用不了", async () => {
    const t = await createTestApp();
    try {
      const admin = await t.admin();
      const me = (await (await admin.get("/api/me")).json()) as { id: string };
      await t.db.insert(passkeys).values({
        userId: me.id,
        credentialId: "old-credential",
        publicKey: "AA",
        counter: 0,
        name: "旧地址上添加的",
        rpId: "old.example.com",
        createdAt: t.clock.now(),
      });
      const listed = (await (await admin.get("/api/auth/passkeys")).json()) as {
        passkeys: Array<{ name: string; usable: boolean }>;
      };
      expect(listed.passkeys).toEqual([
        expect.objectContaining({ name: "旧地址上添加的", usable: false }),
      ]);
    } finally {
      await t.close();
    }
  });
});
