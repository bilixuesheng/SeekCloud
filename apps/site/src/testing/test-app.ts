import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { createInviteCode } from "../server/auth/invites";
import { connectDatabase } from "../server/db/client";
import { runMaintenance } from "../server/maintenance";
import { SecretBox } from "../server/secrets";
import { createTestDatabase } from "./database";
import { FakeGitHub } from "./fake-github";
import { FakeHost } from "./fake-host";
import { FakeClock, FakeMailer } from "./fakes";
import { TestBrowser } from "./test-browser";

export interface TestAppOptions {
  version?: string;
  /** 假时钟的起始时间。 */
  now?: Date;
  /** 内测席位总数，默认足够大。 */
  seatLimit?: number;
  /** 不建新库，直接连这个地址（比如测数据库连不上的情况）。 */
  databaseUrl?: string;
  /** false：没有宿主机连上来。 */
  host?: false;
}

/** 测试缝 ①：在进程内调用主站。每调用一次建一个独立的真实数据库（一般一个测试文件一次），外部依赖全是假的。 */
export async function createTestApp(options: TestAppOptions = {}) {
  const database = options.databaseUrl ? undefined : await createTestDatabase();
  const { db, close } = connectDatabase(options.databaseUrl ?? (database?.url as string));
  const clock = new FakeClock(options.now);
  const mailer = new FakeMailer();
  const github = new FakeGitHub(clock);
  const host = new FakeHost();
  // 导出数据的压缩包写到临时目录，测试结束删掉。
  const dataDir = await mkdtemp(join(tmpdir(), "seekcloud-test-"));
  const deps = {
    publicUrl: "https://seekcloud.test",
    dataDir,
    version: options.version ?? "test",
    db,
    clock,
    mailer,
    seatLimit: options.seatLimit ?? 1000,
    secureCookies: false,
    github,
    secrets: new SecretBox(Buffer.alloc(32, 7)),
    host: options.host === false ? undefined : host,
  };
  const app = createApp(deps);

  return {
    db,
    clock,
    mailer,
    github,
    host,
    request: (path: string, init?: RequestInit) => app.request(path, init),
    /** 一个有自己 Cookie 的浏览器，用来模拟一个已登录或正在登录的用户。 */
    browser: () => new TestBrowser(app),
    /** 建一个邀请码（管理员在命令行里做的事）。 */
    createInvite: (invite: { expiresAt?: Date } = {}) => createInviteCode(deps, invite),
    /** 用 GitHub 注册并登录，把 App 装到这些仓库上。返回登录了的浏览器和假 GitHub 上的用户。 */
    signUpWithGitHub: async (login: string, ...repos: string[]) => {
      const user = github.addUser({ login, email: `${login}@example.com` });
      github.install(user, ...repos.map((fullName) => ({ fullName })));
      const browser = new TestBrowser(app);
      const start = await browser.get("/api/auth/github/start");
      const state = new URL(start.headers.get("location") as string).searchParams.get("state");
      await browser.get(`/api/auth/github/callback?code=${github.authorize(user)}&state=${state}`);
      const inviteCode = await createInviteCode(deps, {});
      const done = await browser.post("/api/auth/pending/register", {
        inviteCode,
        acceptTerms: true,
      });
      if (done.status !== 201) throw new Error(`GitHub 注册失败：${await done.text()}`);
      return { browser, user };
    },
    /** 最近一封发给这个邮箱的验证码。 */
    lastLoginCode: (email: string) => {
      const mail = mailer.sent.findLast((m) => m.to === email);
      const code = mail?.text.match(/\b\d{6}\b/)?.[0];
      if (!code) throw new Error(`没有发给 ${email} 的验证码`);
      return code;
    },
    dataDir,
    /** 跑一次后台的定期任务（main.ts 里每分钟一次）：打包导出、清理过期导出和已删除的账户。 */
    runMaintenance: () => runMaintenance(deps),
    close: async () => {
      await rm(dataDir, { recursive: true, force: true });
      await close();
      await database?.drop();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
