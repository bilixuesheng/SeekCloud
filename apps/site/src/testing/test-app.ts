import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type AppDeps, createApp } from "../server/app";
import { hasAdmin } from "../server/auth/admin";
import { adminIdentity } from "../server/auth/admin-identity";
import { connectDatabase } from "../server/db/client";
import { HostHub } from "../server/hosts/hub";
import { runMaintenance } from "../server/maintenance";
import type { Identity, SettingsPolicy } from "../server/ports";
import { SecretBox } from "../server/secrets";
import { adminSettings } from "../server/settings";
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
  /**
   * 用真的宿主机连接（HostHub）代替假宿主机：主站起一个真的 HTTP 服务，t.hostUrl 是宿主机连接的地址，
   * 测试用 src/testing/host-client.ts 扮演宿主机守护进程。定时检查不自己跑，测试调用 t.hub.tick()。
   */
  hosts?: true;
  /**
   * 换掉身份来源（扩展点，ADR 0010）。默认是主干的管理员密码登录；换掉以后 t.admin()、t.adminWithGitHub()
   * 不能用，由测试自己登录。
   */
  identity?: (deps: Pick<AppDeps, "db" | "clock" | "secureCookies">) => Identity;
  /** 换掉设置的读写规则（扩展点）。默认是主干的 adminSettings。 */
  settingsPolicy?: SettingsPolicy;
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
  const base = {
    dataDir,
    version: options.version ?? "test",
    db,
    clock,
    secureCookies: false,
    github,
    secrets: new SecretBox(Buffer.alloc(32, 7)),
    host: options.host === false ? undefined : host,
  };
  const deps: AppDeps = {
    ...base,
    identity: (options.identity ?? adminIdentity)(base),
    settingsPolicy: options.settingsPolicy ?? adminSettings,
  };
  const hub = options.hosts ? new HostHub(deps) : undefined;
  if (hub) deps.host = hub;
  const app = createApp(deps);
  let server: Server | undefined;
  let hostUrl = "";
  if (hub) {
    server = await new Promise<Server>((resolve) => {
      const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(s as Server),
      ) as Server;
    });
    hub.attach(server);
    await hub.start({ tick: false });
    hostUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** 管理员在一个新的浏览器（新设备）上登录；还没设置过密码时先设置。改过密码以后不能再用。 */
  const admin = async () => {
    if (options.identity) throw new Error("换了身份来源以后不能用 t.admin()，请测试自己登录");
    const browser = new TestBrowser(app);
    const path = (await hasAdmin(db)) ? "/api/auth/login" : "/api/auth/setup";
    const res = await browser.post(path, { password: ADMIN_PASSWORD, nickname: "管理员" });
    if (res.status !== 204) throw new Error(`管理员登录失败：${await res.text()}`);
    return browser;
  };

  /**
   * 已登录的浏览器关联 GitHub 账号 login，并把 App 装到这些仓库上。返回假 GitHub 上的用户。
   * 换了身份来源的测试用它给每个身份各关联一个 GitHub 账号。
   */
  const linkGitHub = async (browser: TestBrowser, login: string, ...repos: string[]) => {
    const user = github.addUser({ login });
    github.install(user, ...repos.map((fullName) => ({ fullName })));
    const start = await browser.get("/api/auth/github/start");
    const state = new URL(start.headers.get("location") as string).searchParams.get("state");
    const done = await browser.get(
      `/api/auth/github/callback?code=${github.authorize(user)}&state=${state}`,
    );
    const location = done.headers.get("location");
    if (location !== "/") throw new Error(`关联 GitHub 失败：跳到了 ${location}`);
    return user;
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
      const browser = await admin();
      return { browser, user: await linkGitHub(browser, login, ...repos) };
    },
    linkGitHub,
    dataDir,
    /** 跑一次后台的定期任务（main.ts 里每分钟一次）：打包导出、清理过期导出和访问记录。 */
    runMaintenance: () => runMaintenance(deps),
    /** 真的宿主机连接（只在 hosts: true 时有）。 */
    hub: hub as HostHub,
    /** 宿主机连主站的地址，比如 ws://127.0.0.1:端口（只在 hosts: true 时有）。 */
    hostUrl,
    close: async () => {
      await hub?.stop();
      if (server) await new Promise((resolve) => server?.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
      await close();
      await database?.drop();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
