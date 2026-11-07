import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import { resetAdminPassword } from "./auth/admin";

const DAY = 24 * 60 * 60_000;
/** 最长允许 256 位，多一位就超长。 */
const TOO_LONG = "a".repeat(257);

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("首次设置管理员密码", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("还没设置时，/api/me 返回 401，错误码说明要先设置密码", async () => {
    const res = await t.browser().get("/api/me");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "setup_required", message: "请先设置管理员密码" },
    });
  });

  it("密码少于 8 位：400，不建账户", async () => {
    const res = await t.browser().post("/api/auth/setup", { password: "1234567" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_request", message: "密码至少 8 位" },
    });
    expect(await errorCode(await t.browser().get("/api/me"))).toBe("setup_required");
  });

  it("密码超过 256 位：400，不建账户", async () => {
    const res = await t.browser().post("/api/auth/setup", { password: TOO_LONG });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_request", message: "密码最长 256 位" },
    });
    expect(await errorCode(await t.browser().get("/api/me"))).toBe("setup_required");
  });

  it("设置后直接登录；自动有一个默认环境", async () => {
    const browser = t.browser();

    const res = await browser.post("/api/auth/setup", { password: "first-password" });

    expect(res.status).toBe(204);
    expect(await (await browser.get("/api/me")).json()).toEqual({
      id: expect.any(String),
      githubLogin: null,
    });
    expect(await (await browser.get("/api/environments")).json()).toEqual({
      environments: [
        { id: expect.any(String), name: "默认环境", networkAccess: "default", isDefault: true },
      ],
    });
  });

  it("设置过以后不能再设置：409，密码不变", async () => {
    const res = await t.browser().post("/api/auth/setup", { password: "second-password" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "already_set_up", message: "已设置管理员密码，请直接登录" },
    });
    expect((await t.browser().post("/api/auth/login", { password: "first-password" })).status).toBe(
      204,
    );
    expect(await errorCode(await t.browser().get("/api/me"))).toBe("unauthorized");
  });
});

describe("登录", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await t.admin();
  });
  afterAll(() => t.close());

  it("密码正确就登录", async () => {
    const browser = t.browser();

    const res = await browser.post("/api/auth/login", { password: t.adminPassword });

    expect(res.status).toBe(204);
    expect((await browser.get("/api/me")).status).toBe(200);
  });

  it("密码错误：400，不登录", async () => {
    const browser = t.browser();

    const res = await browser.post("/api/auth/login", { password: "wrong-password" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "wrong_password", message: "密码错误" } });
    const me = await browser.get("/api/me");
    expect(me.status).toBe(401);
    expect(await me.json()).toEqual({ error: { code: "unauthorized", message: "请先登录" } });
  });

  it("密码超过 256 位：按密码错误处理", async () => {
    const res = await t.browser().post("/api/auth/login", { password: TOO_LONG });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "wrong_password", message: "密码错误" } });
  });

  it("退出登录后，再访问需要登录的接口返回 401", async () => {
    const browser = await t.admin();

    expect((await browser.post("/api/auth/logout")).status).toBe(204);

    expect((await browser.get("/api/me")).status).toBe(401);
  });

  it("登录状态 30 天后失效", async () => {
    const browser = await t.admin();
    t.clock.advance(30 * DAY + 1);

    expect((await browser.get("/api/me")).status).toBe(401);
  });
});

describe("修改密码", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("当前密码错误：400，密码不变", async () => {
    const browser = await t.admin();

    const res = await browser.post("/api/auth/password", {
      currentPassword: "wrong-password",
      newPassword: "new-password",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "wrong_password", message: "当前密码错误" },
    });
    expect((await browser.get("/api/me")).status).toBe(200);
    expect((await t.browser().post("/api/auth/login", { password: "new-password" })).status).toBe(
      400,
    );
  });

  it("新密码少于 8 位：400", async () => {
    const browser = await t.admin();

    const res = await browser.post("/api/auth/password", {
      currentPassword: t.adminPassword,
      newPassword: "short",
    });

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });

  it("新密码超过 256 位：400；当前密码超过 256 位：按当前密码错误处理", async () => {
    const browser = await t.admin();

    const longNew = await browser.post("/api/auth/password", {
      currentPassword: t.adminPassword,
      newPassword: TOO_LONG,
    });
    const longCurrent = await browser.post("/api/auth/password", {
      currentPassword: TOO_LONG,
      newPassword: "new-password",
    });

    expect(longNew.status).toBe(400);
    expect(await longNew.json()).toEqual({
      error: { code: "invalid_request", message: "密码最长 256 位" },
    });
    expect(longCurrent.status).toBe(400);
    expect(await errorCode(longCurrent)).toBe("wrong_password");
  });

  it("没登录：401", async () => {
    const res = await t.browser().post("/api/auth/password", {
      currentPassword: t.adminPassword,
      newPassword: "new-password",
    });

    expect(res.status).toBe(401);
  });

  it("改完以后：当前设备保持登录，其他设备全部退出；旧密码不能再登录，新密码可以", async () => {
    const laptop = await t.admin();
    const phone = await t.admin();

    const res = await laptop.post("/api/auth/password", {
      currentPassword: t.adminPassword,
      newPassword: "new-password",
    });

    expect(res.status).toBe(204);
    expect((await laptop.get("/api/me")).status).toBe(200);
    expect((await phone.get("/api/me")).status).toBe(401);
    expect((await t.browser().post("/api/auth/login", { password: t.adminPassword })).status).toBe(
      400,
    );
    expect((await t.browser().post("/api/auth/login", { password: "new-password" })).status).toBe(
      204,
    );
  });

  it("正好 256 位的新密码可以用", async () => {
    const browser = t.browser();
    expect((await browser.post("/api/auth/login", { password: "new-password" })).status).toBe(204);
    const longest = "b".repeat(256);

    const res = await browser.post("/api/auth/password", {
      currentPassword: "new-password",
      newPassword: longest,
    });

    expect(res.status).toBe(204);
    expect((await t.browser().post("/api/auth/login", { password: longest })).status).toBe(204);
  });
});

describe("在所有设备上退出", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("手机和电脑都登录着：在一台上点退出所有设备，两台都退出", async () => {
    const laptop = await t.admin();
    const phone = await t.admin();

    expect((await laptop.post("/api/auth/logout-all", {})).status).toBe(204);

    expect((await laptop.get("/api/me")).status).toBe(401);
    expect((await phone.get("/api/me")).status).toBe(401);
  });

  it("没登录：401", async () => {
    expect((await t.browser().post("/api/auth/logout-all", {})).status).toBe(401);
  });
});

describe("在服务器上重置密码", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("还没设置管理员密码时：什么都不做，返回 undefined", async () => {
    expect(await resetAdminPassword(t.db)).toBeUndefined();
    expect(await errorCode(await t.browser().get("/api/me"))).toBe("setup_required");
  });

  it("生成一个随机密码：旧密码作废，所有设备退出，新密码可以登录", async () => {
    const laptop = await t.admin();
    const phone = await t.admin();

    const password = await resetAdminPassword(t.db);

    expect(password).toMatch(/^[\w-]{16}$/);
    expect((await laptop.get("/api/me")).status).toBe(401);
    expect((await phone.get("/api/me")).status).toBe(401);
    expect((await t.browser().post("/api/auth/login", { password: t.adminPassword })).status).toBe(
      400,
    );
    expect((await t.browser().post("/api/auth/login", { password })).status).toBe(204);
    expect(await resetAdminPassword(t.db)).not.toBe(password);
  });
});
