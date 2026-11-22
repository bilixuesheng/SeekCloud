import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";
import { accessLogs } from "../db/schema";
import { resetAdminPassword } from "./admin";
import { TOTP_PERIOD_SECONDS, timeStep, totpCode } from "./totp";

/** 两步验证（#100 的 TOTP 部分）：开启、登录的第二步、恢复码、敏感操作再验证、关闭、重置命令。时钟是假的。 */

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe("两步验证", () => {
  let t: TestApp;
  let admin: TestBrowser;
  let secret: string;
  let recovery: string[];

  /** 当前时间步的验证码。用过一个以后要等下一个时间步。 */
  const code = () => totpCode(secret, timeStep(t.clock.now()));
  const nextStep = () => t.clock.advance(TOTP_PERIOD_SECONDS * 1000);
  const state = async () =>
    (await (await admin.get("/api/auth/two-factor")).json()) as {
      enabled: boolean;
      recoveryCodesLeft: number;
    };
  const events = async (event: "two_factor_on" | "two_factor_off") =>
    t.db
      .select({ id: accessLogs.id })
      .from(accessLogs)
      .where(and(eq(accessLogs.event, event)));
  /** 新设备输密码：开了两步验证时回 202 和中间令牌。 */
  const firstStep = async (b: TestBrowser, extra: Record<string, unknown> = {}) => {
    const res = await b.post("/api/auth/login", { password: t.adminPassword, ...extra });
    expect(res.status).toBe(202);
    expect(res.headers.getSetCookie()).toEqual([]);
    return (await res.json()) as { secondFactor: string; pendingToken: string; expiresAt: string };
  };

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.admin();
  });
  afterAll(() => t.close());

  it("开启：先输密码拿到密钥和二维码地址；输对一次验证码才生效，回 10 个恢复码；记一条访问记录", async () => {
    expect(await state()).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    const wrong = await admin.post("/api/auth/two-factor/setup", { password: "nope" });
    expect(wrong.status).toBe(400);
    expect(await errorCode(wrong)).toBe("wrong_password");

    const setup = (await (
      await admin.post("/api/auth/two-factor/setup", { password: t.adminPassword })
    ).json()) as { secret: string; otpauthUrl: string; setupToken: string };
    secret = setup.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUrl).toContain(`secret=${secret}`);
    // 还没输验证码：没开
    expect((await state()).enabled).toBe(false);

    const bad = await admin.post("/api/auth/two-factor/enable", {
      setupToken: setup.setupToken,
      code: "000000" === code() ? "111111" : "000000",
    });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("wrong_code");
    // 别人的、改过的设置令牌不认
    const tampered = await admin.post("/api/auth/two-factor/enable", {
      setupToken: `${setup.setupToken.slice(0, -2)}xx`,
      code: code(),
    });
    expect(await errorCode(tampered)).toBe("setup_expired");

    const enabled = await admin.post("/api/auth/two-factor/enable", {
      setupToken: setup.setupToken,
      code: code(),
    });
    expect(enabled.status).toBe(200);
    recovery = ((await enabled.json()) as { recoveryCodes: string[] }).recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect(await state()).toEqual({ enabled: true, recoveryCodesLeft: 10 });
    expect(await events("two_factor_on")).toHaveLength(1);
    // 已经开着：再开回 409
    expect(
      (await admin.post("/api/auth/two-factor/setup", { password: t.adminPassword })).status,
    ).toBe(409);
    // 开启前已经登录着的设备不退出
    expect((await admin.get("/api/me")).status).toBe(200);
  });

  it("登录：密码对了只给中间令牌（不设 Cookie，也不能当登录状态用）；输对验证码才登录；开启时用过的验证码不能再用", async () => {
    const laptop = t.browser();
    const { secondFactor, pendingToken, expiresAt } = await firstStep(laptop);
    expect(secondFactor).toBe("totp");
    expect(new Date(expiresAt).getTime() - t.clock.now().getTime()).toBe(5 * 60_000);
    expect((await laptop.get("/api/me")).status).toBe(401);
    const asBearer = await t
      .browser()
      .request("/api/me", { headers: { authorization: `Bearer ${pendingToken}` } });
    expect(asBearer.status).toBe(401);

    // 开启时刚用过这一个时间步的验证码
    const reused = await laptop.post("/api/auth/login/verify", { pendingToken, code: code() });
    expect(reused.status).toBe(400);
    expect(await errorCode(reused)).toBe("wrong_code");

    nextStep();
    const ok = await laptop.post("/api/auth/login/verify", { pendingToken, code: code() });
    expect(ok.status).toBe(204);
    expect((await laptop.get("/api/me")).status).toBe(200);

    // 同一个验证码换一台设备也不能再用
    const phone = t.browser();
    const again = await firstStep(phone);
    const replay = await phone.post("/api/auth/login/verify", {
      pendingToken: again.pendingToken,
      code: code(),
    });
    expect(await errorCode(replay)).toBe("wrong_code");
  });

  it("恢复码：能代替验证码登录，每个只能用一次；格式不计较大小写和空格", async () => {
    const used = recovery[0] as string;
    const b = t.browser();
    const { pendingToken } = await firstStep(b);
    const res = await b.post("/api/auth/login/verify", {
      pendingToken,
      code: ` ${used.toUpperCase().replace("-", " ")} `,
    });
    expect(res.status).toBe(204);
    expect((await state()).recoveryCodesLeft).toBe(9);

    const other = t.browser();
    const second = await firstStep(other);
    expect(
      await errorCode(
        await other.post("/api/auth/login/verify", {
          pendingToken: second.pendingToken,
          code: used,
        }),
      ),
    ).toBe("wrong_code");
  });

  it("安卓 App：第二步过了才发设备令牌", async () => {
    nextStep();
    const app = t.browser();
    const { pendingToken } = await firstStep(app, { client: "app", deviceName: "Pixel 9" });
    const res = await app.post("/api/auth/login/verify", { pendingToken, code: code() });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const { token } = (await res.json()) as { token: string };
    const me = await t
      .browser()
      .request("/api/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    const devices = (await (await admin.get("/api/auth/devices")).json()) as {
      devices: Array<{ deviceName: string | null }>;
    };
    expect(devices.devices.map((d) => d.deviceName)).toContain("Pixel 9");
  });

  it("中间令牌 5 分钟过期；改过的、开启用的设置令牌都不能拿来登录", async () => {
    const b = t.browser();
    const { pendingToken } = await firstStep(b);
    t.clock.advance(5 * 60_000 + 1000);
    const expired = await b.post("/api/auth/login/verify", { pendingToken, code: code() });
    expect(expired.status).toBe(400);
    expect(await errorCode(expired)).toBe("login_expired");
    const forged = await b.post("/api/auth/login/verify", {
      pendingToken: "not-a-token",
      code: code(),
    });
    expect(await errorCode(forged)).toBe("login_expired");
  });

  it("改密码：开了两步验证要带验证码；不带、带错都不改", async () => {
    nextStep();
    const body = { currentPassword: t.adminPassword, newPassword: "a-new-password" };
    const missing = await admin.post("/api/auth/password", body);
    expect(await errorCode(missing)).toBe("code_required");
    const wrongCode = await admin.post("/api/auth/password", { ...body, code: "12345x" });
    expect(await errorCode(wrongCode)).toBe("wrong_code");
    const wrongPassword = await admin.post("/api/auth/password", {
      ...body,
      currentPassword: "nope",
      code: code(),
    });
    expect(await errorCode(wrongPassword)).toBe("wrong_password");
    const ok = await admin.post("/api/auth/password", { ...body, code: code() });
    expect(ok.status).toBe(204);
    // 改回来，后面的测试照常用 t.adminPassword
    nextStep();
    expect(
      (
        await admin.post("/api/auth/password", {
          currentPassword: "a-new-password",
          newPassword: t.adminPassword,
          code: code(),
        })
      ).status,
    ).toBe(204);
  });

  it("重新生成恢复码：要密码和验证码；旧的全部作废，新的能用", async () => {
    nextStep();
    const res = await admin.post("/api/auth/two-factor/recovery-codes", {
      password: t.adminPassword,
      code: code(),
    });
    expect(res.status).toBe(200);
    const fresh = ((await res.json()) as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(await state()).toEqual({ enabled: true, recoveryCodesLeft: 10 });

    const b = t.browser();
    const old = await firstStep(b);
    expect(
      await errorCode(
        await b.post("/api/auth/login/verify", {
          pendingToken: old.pendingToken,
          code: recovery[1],
        }),
      ),
    ).toBe("wrong_code");
    expect(
      (
        await b.post("/api/auth/login/verify", {
          pendingToken: old.pendingToken,
          code: fresh[0],
        })
      ).status,
    ).toBe(204);
    recovery = fresh.slice(1);
  });

  it("输错验证码和输错密码共用一个频率限制：同一个来源一小时 10 次，之后对的也要等", async () => {
    const b = t.browser();
    const { pendingToken } = await firstStep(b);
    for (let i = 0; i < 9; i++) {
      const res = await b.post("/api/auth/login/verify", { pendingToken, code: "abcdefghjk" });
      expect(res.status).toBe(400);
    }
    // 第 10 次是输错密码
    expect((await b.post("/api/auth/login", { password: "nope" })).status).toBe(400);
    const limited = await b.post("/api/auth/login/verify", { pendingToken, code: recovery[0] });
    expect(limited.status).toBe(429);
    expect((await b.post("/api/auth/login", { password: t.adminPassword })).status).toBe(429);
    t.clock.advance(60 * 60_000);
  });

  it("关闭：要密码和验证码；关了以后密码直接登录；记一条访问记录", async () => {
    const missing = await admin.post("/api/auth/two-factor/disable", {
      password: t.adminPassword,
      code: "",
    });
    expect(await errorCode(missing)).toBe("code_required");
    nextStep();
    const res = await admin.post("/api/auth/two-factor/disable", {
      password: t.adminPassword,
      code: code(),
    });
    expect(res.status).toBe(204);
    expect(await state()).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    expect(await events("two_factor_off")).toHaveLength(1);
    expect((await t.browser().post("/api/auth/login", { password: t.adminPassword })).status).toBe(
      204,
    );
    expect(
      (await admin.post("/api/auth/two-factor/disable", { password: t.adminPassword, code: "1" }))
        .status,
    ).toBe(409);
  });

  it("服务器上的重置命令：同时关掉两步验证", async () => {
    const setup = (await (
      await admin.post("/api/auth/two-factor/setup", { password: t.adminPassword })
    ).json()) as { secret: string; setupToken: string };
    secret = setup.secret;
    nextStep();
    await admin.post("/api/auth/two-factor/enable", { setupToken: setup.setupToken, code: code() });
    expect((await state()).enabled).toBe(true);

    const reset = await resetAdminPassword(t.db);
    expect(reset?.twoFactorWasOn).toBe(true);
    const b = t.browser();
    expect((await b.post("/api/auth/login", { password: reset?.password })).status).toBe(204);
    expect(
      (await (await b.get("/api/auth/two-factor")).json()) as { enabled: boolean },
    ).toMatchObject({ enabled: false });
  });
});
