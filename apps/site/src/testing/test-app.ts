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
import { configuredRouting, transparentErrors, usageAdmission } from "../server/gateway/trunk";
import { HostHub } from "../server/hosts/hub";
import { createHost } from "../server/hosts/keys";
import { runMaintenance } from "../server/maintenance";
import { createModelCatalog, updateProvider } from "../server/models/providers";
import type { OutboundNetwork } from "../server/network/address";
import type {
  ErrorPresentation,
  Identity,
  ModelAdmission,
  ProviderRouting,
  SettingsPolicy,
} from "../server/ports";
import { SecretBox } from "../server/secrets";
import { adminSettings } from "../server/settings";
import { createTestDatabase } from "./database";
import { FakeGitHub } from "./fake-github";
import { FakeHost } from "./fake-host";
import { FakeModelProvider } from "./fake-model";
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
  /** 换掉模型网关的三个扩展点。默认是主干的实现（gateway/trunk.ts）。 */
  modelAdmission?: ModelAdmission;
  providerRouting?: ProviderRouting;
  errorPresentation?: ErrorPresentation;
  /** false：还没填模型服务的 key。默认填好了一个假的，模型请求发到假的提供方 t.model。 */
  modelKey?: false;
  /**
   * 模型请求不发给 t.model，用这个 fetch 发到 modelBaseUrl（端到端测试：发到宿主机测试里按脚本回复的假模型）。
   */
  modelFetch?: typeof fetch;
  modelBaseUrl?: string;
  /** 平台自己发起的模型调用（判断是否在等输入、置顶的短标题）。默认关，只用规则；测它们的测试打开。 */
  platformCalls?: { timeoutMs?: number };
  /** 网页抓取怎么解析域名、哪些地址能连。默认是真的（只连公网）。 */
  outboundNetwork?: OutboundNetwork;
  webFetchTimeoutMs?: number;
  /** 事件流的保活间隔（同时核对登录状态），默认 25 秒。测"退出以后事件流断开"时改短。 */
  streamKeepaliveMs?: number;
  /** 主站读到的环境变量（模型提供方没填 key 时读）。默认是空的，不读跑测试的机器上的。 */
  env?: Record<string, string | undefined>;
  /** DeepSeek 发布的模型列表。默认关（只用内置的两个）；测它的测试打开。 */
  deepseekListing?: { timeoutMs?: number; maxAgeMs?: number };
  /** 主站对外的地址（通行密钥按它定 rpId 和来源）。默认 TEST_PUBLIC_URL；null 是没配。 */
  publicUrl?: string | null;
}

/** 测试里主站对外的地址。假认证器（src/testing/fake-authenticator.ts）按它签名。 */
export const TEST_PUBLIC_URL = "https://seekcloud.test";

/** 测试里填好的模型服务 key（发给假提供方的请求里应该带着它）。 */
export const MODEL_KEY = "sk-test-0123456789abcdef";

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
    publicUrl: options.publicUrl === null ? undefined : (options.publicUrl ?? TEST_PUBLIC_URL),
    host: options.host === false ? undefined : host,
    env: options.env ?? {},
  };
  const model = new FakeModelProvider();
  const settingsPolicy = options.settingsPolicy ?? adminSettings;
  const models = createModelCatalog({
    ...base,
    settingsPolicy,
    modelFetch: options.modelFetch ?? model.fetch,
    deepseekListing: options.deepseekListing ?? false,
  });
  const deps: AppDeps = {
    ...base,
    identity: (options.identity ?? adminIdentity)({ ...base, settingsPolicy }),
    settingsPolicy,
    modelAdmission: options.modelAdmission ?? usageAdmission(base),
    providerRouting:
      options.providerRouting ?? configuredRouting({ ...base, settingsPolicy }, models),
    errorPresentation: options.errorPresentation ?? transparentErrors,
    modelFetch: options.modelFetch ?? model.fetch,
    outboundNetwork: options.outboundNetwork,
    webFetchTimeoutMs: options.webFetchTimeoutMs,
    streamKeepaliveMs: options.streamKeepaliveMs,
    platformCalls: options.platformCalls ?? false,
    deepseekListing: options.deepseekListing ?? false,
    models,
  };
  if (options.modelKey !== false) {
    try {
      await updateProvider(deps, "deepseek", {
        apiKey: MODEL_KEY,
        baseUrl: options.modelBaseUrl ?? "https://model.test/anthropic",
      });
    } catch (error) {
      // 测数据库连不上的情况（databaseUrl 指向一个不存在的库）：填不了 key，也用不着。
      if (!options.databaseUrl) throw error;
    }
  }
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
    /** 假的模型服务：模型网关发出去的请求都记在这里，可以按脚本回。 */
    model,
    deps,
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
    /** 添加一台宿主机，返回它的密钥（pnpm host:create 做的事）。 */
    addHost: (name: string) => createHost(db, name, clock.now()),
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
