import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { hasAdmin } from "../server/auth/admin";
import { connectDatabase } from "../server/db/client";
import { runMaintenance } from "../server/maintenance";
import { SecretBox } from "../server/secrets";
import { createTestDatabase } from "./database";
import { FakeGitHub } from "./fake-github";
import { FakeHost } from "./fake-host";
import { FakeClock } from "./fakes";
import { TestBrowser } from "./test-browser";

export interface TestAppOptions {
  version?: string;
  /** 假时钟的起始时间。 */
  now?: Date;
  /** 不建新库，直接连这个地址（比如测数据库连不上的情况）。 */
  databaseUrl?: string;
  /** false：没有宿主机连上来。 */
  host?: false;
}

/** t.admin() 设置和登录时用的管理员密码。 */
const ADMIN_PASSWORD = "test-admin-password";

/** 测试缝 ①：在进程内调用主站。每调用一次建一个独立的真实数据库（一般一个测试文件一次），外部依赖全是假的。 */
export async function createTestApp(options: TestAppOptions = {}) {
  const database = options.databaseUrl ? undefined : await createTestDatabase();
  const { db, close } = connectDatabase(options.databaseUrl ?? (database?.url as string));
  const clock = new FakeClock(options.now);
  const github = new FakeGitHub(clock);
  const host = new FakeHost();
  // 导出数据的压缩包写到临时目录，测试结束删掉。
  const dataDir = await mkdtemp(join(tmpdir(), "seekcloud-test-"));
  const deps = {
    dataDir,
    version: options.version ?? "test",
    db,
    clock,
    secureCookies: false,
    github,
    secrets: new SecretBox(Buffer.alloc(32, 7)),
    host: options.host === false ? undefined : host,
  };
  const app = createApp(deps);

  /** 管理员在一个新的浏览器（新设备）上登录；还没设置过密码时先设置。改过密码以后不能再用。 */
  const admin = async () => {
    const browser = new TestBrowser(app);
    const path = (await hasAdmin(db)) ? "/api/auth/login" : "/api/auth/setup";
    const res = await browser.post(path, { password: ADMIN_PASSWORD });
    if (res.status !== 204) throw new Error(`管理员登录失败：${await res.text()}`);
    return browser;
  };

  return {
    db,
    clock,
    github,
    host,
    request: (path: string, init?: RequestInit) => app.request(path, init),
    /** 一个有自己 Cookie 的浏览器，还没有登录。 */
    browser: () => new TestBrowser(app),
    adminPassword: ADMIN_PASSWORD,
    admin,
    /**
     * 管理员登录，关联 GitHub 账号 login，并把 App 装到这些仓库上。返回登录了的浏览器和假 GitHub 上的用户。
     * 再调用一次会把关联换成新的 GitHub 账号。
     */
    adminWithGitHub: async (login: string, ...repos: string[]) => {
      const user = github.addUser({ login });
      github.install(user, ...repos.map((fullName) => ({ fullName })));
      const browser = await admin();
      const start = await browser.get("/api/auth/github/start");
      const state = new URL(start.headers.get("location") as string).searchParams.get("state");
      const done = await browser.get(
        `/api/auth/github/callback?code=${github.authorize(user)}&state=${state}`,
      );
      const location = done.headers.get("location");
      if (location !== "/") throw new Error(`关联 GitHub 失败：跳到了 ${location}`);
      return { browser, user };
    },
    dataDir,
    /** 跑一次后台的定期任务（main.ts 里每分钟一次）：打包导出、清理过期导出和访问记录。 */
    runMaintenance: () => runMaintenance(deps),
    close: async () => {
      await rm(dataDir, { recursive: true, force: true });
      await close();
      await database?.drop();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
