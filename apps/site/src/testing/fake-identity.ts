import { randomBytes } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDeps } from "../server/app";
import { users } from "../server/db/schema";
import { createDefaultEnvironment } from "../server/environments";
import { notLoggedIn } from "../server/errors";
import type { CurrentUser, Identity } from "../server/ports";
import { newRouter } from "../server/routes/router";
import type { TestBrowser } from "./test-browser";

const COOKIE = "fake_login";

/**
 * 测试用的身份来源：库里可以有好几个人，登录就是拿到一个 Cookie。只是测试替身，产品里没有第二个账户
 * （ADR 0008）。隔离测试用它检查两个人互相看不到对方的数据。
 *
 *   const identity = new FakeIdentity();
 *   const t = await createTestApp({ identity: identity.attach });
 *   const alice = await identity.signIn(t.browser(), await identity.addUser("甲"));
 */
export class FakeIdentity implements Identity {
  #deps: Pick<AppDeps, "db" | "clock"> | undefined;
  /** 登录状态：Cookie 的值 → 用户 ID。退出时删掉。 */
  readonly #logins = new Map<string, string>();

  readonly routes = newRouter()
    .post("/fake-login", async (c) => {
      const { userId } = z.object({ userId: z.string() }).parse(await c.req.json());
      const token = randomBytes(16).toString("base64url");
      this.#logins.set(token, userId);
      setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/" });
      return c.body(null, 204);
    })
    .post("/logout", (c) => {
      const token = getCookie(c, COOKIE);
      if (token) this.#logins.delete(token);
      deleteCookie(c, COOKIE, { path: "/" });
      return c.body(null, 204);
    });

  /** 交给 createTestApp 的 identity 选项。 */
  readonly attach = (deps: Pick<AppDeps, "db" | "clock">): Identity => {
    this.#deps = deps;
    return this;
  };

  async currentUser(c: Context): Promise<CurrentUser | undefined> {
    const userId = this.#logins.get(getCookie(c, COOKIE) ?? "");
    return userId ? { id: userId } : undefined;
  }

  async loggedOut() {
    return notLoggedIn;
  }

  /** 在库里加一个人，带一个默认环境（和管理员首次设置时一样）。返回这个人的 ID。 */
  async addUser(nickname: string): Promise<string> {
    const deps = this.#deps;
    if (!deps) throw new Error("FakeIdentity 还没交给 createTestApp");
    const now = deps.clock.now();
    return deps.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        // 这个人不用密码登录：存一个任何密码都对不上的值。
        .values({ passwordHash: "!", nickname, createdAt: now })
        .returning({ id: users.id });
      const id = (row as { id: string }).id;
      await createDefaultEnvironment(tx, id, now);
      return id;
    });
  }

  /** 这个浏览器以 userId 的身份登录。返回同一个浏览器。 */
  async signIn(browser: TestBrowser, userId: string): Promise<TestBrowser> {
    const res = await browser.post("/api/auth/fake-login", { userId });
    if (res.status !== 204) throw new Error(`登录失败：${res.status}`);
    return browser;
  }
}
