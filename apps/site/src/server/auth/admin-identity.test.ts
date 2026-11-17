import { describeIdentityContract } from "../../testing/identity-contract";
import { createTestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";

describeIdentityContract("主干的管理员密码登录", async () => {
  const t = await createTestApp();
  let password = t.adminPassword;
  let changes = 0;

  const expect204 = async (res: Response, what: string) => {
    if (res.status !== 204) throw new Error(`${what}失败：${res.status} ${await res.text()}`);
  };

  return {
    driver: {
      browser: () => t.browser(),
      logIn: async (browser: TestBrowser) => {
        const setUp =
          (await (await browser.get("/api/me")).json()).error?.code !== "setup_required";
        const path = setUp ? "/api/auth/login" : "/api/auth/setup";
        await expect204(await browser.post(path, { password, nickname: "管理员" }), "登录");
        return browser;
      },
      logOut: async (browser: TestBrowser) =>
        expect204(await browser.post("/api/auth/logout"), "退出"),
      changeCredential: async (browser: TestBrowser) => {
        const newPassword = `${t.adminPassword}-${++changes}`;
        await expect204(
          await browser.post("/api/auth/password", { currentPassword: password, newPassword }),
          "改密码",
        );
        password = newPassword;
      },
    },
    close: t.close,
  };
});
