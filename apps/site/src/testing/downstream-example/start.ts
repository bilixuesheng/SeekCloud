// 最小下游（ADR 0010）：一个假想的下游版本怎么接进主干。只从主站包的公开出口拿东西
// （@seekcloud/site/server 和 /testing），不引用主站里面的文件，也不改主站的任何文件：
//
// - 换掉两个扩展点：身份来源用测试替身 FakeIdentity，设置规则用下面的 exampleSettings；
// - 自己的表放在自己的迁移目录里（./migrations），用自己的记录表；
// - 自己的接口挂在主站上，登录状态照样问身份来源。
//
// 起一个真的 HTTP 服务。downstream-example.test.ts 走一遍登录、发起会话。

import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  type AppDeps,
  adminSettings,
  apiError,
  connectDatabase,
  createApp,
  notLoggedIn,
  runMigrations,
  SecretBox,
  type SettingsPolicy,
} from "@seekcloud/site/server";
import {
  createTestDatabase,
  FakeClock,
  FakeGitHub,
  FakeHost,
  FakeIdentity,
  type TestBrowser,
} from "@seekcloud/site/testing";
import { sql } from "drizzle-orm";

const MIGRATIONS = {
  folder: fileURLToPath(new URL("./migrations", import.meta.url)),
  table: "__example_migrations",
};

/** 下游的设置规则：AI 标识不让关，新会话默认低档思考。其余照主干。 */
export const exampleSettings: SettingsPolicy = {
  defaultValue: (key, actor) =>
    key === "default_effort" ? ("low" as never) : adminSettings.defaultValue(key, actor),
  canWrite: (key) => key !== "ai_labels",
};

export async function startDownstreamExample() {
  const database = await createTestDatabase();
  const { db, close } = connectDatabase(database.url);
  await runMigrations(db, [MIGRATIONS]);

  const clock = new FakeClock();
  const github = new FakeGitHub(clock);
  const host = new FakeHost();
  const identity = new FakeIdentity();
  const dataDir = await mkdtemp(join(tmpdir(), "seekcloud-example-"));
  const base = {
    version: "example",
    dataDir,
    db,
    clock,
    secureCookies: false,
    github,
    secrets: new SecretBox(Buffer.alloc(32, 9)),
    host,
  };
  const deps: AppDeps = {
    ...base,
    identity: identity.attach(base),
    settingsPolicy: exampleSettings,
  };
  const app = createApp(deps);

  // 下游自己的接口：读写自己的表，登录状态问身份来源。
  app.get("/api/example/notes", async (c) => {
    const me = await deps.identity.currentUser(c);
    if (!me) return c.json(notLoggedIn, 401);
    const rows = await db.execute<{ body: string }>(
      sql`select body from example_notes where user_id = ${me.id} order by id`,
    );
    return c.json({ notes: rows.rows.map((r) => r.body) }, 200);
  });
  app.post("/api/example/notes", async (c) => {
    const me = await deps.identity.currentUser(c);
    if (!me) return c.json(notLoggedIn, 401);
    const { body } = (await c.req.json()) as { body?: unknown };
    if (typeof body !== "string") return c.json(apiError("invalid_request", "缺少内容"), 400);
    await db.execute(sql`insert into example_notes (user_id, body) values (${me.id}, ${body})`);
    return c.body(null, 204);
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** 已登录的浏览器关联 GitHub 账号 login，并把 App 装到 repo 上。 */
  const linkGitHub = async (browser: TestBrowser, login: string, repo: string) => {
    const user = github.addUser({ login });
    github.install(user, { fullName: repo });
    const start = await browser.get("/api/auth/github/start");
    const state = new URL(start.headers.get("location") as string).searchParams.get("state");
    const done = await browser.get(
      `/api/auth/github/callback?code=${github.authorize(user)}&state=${state}`,
    );
    if (done.headers.get("location") !== "/") throw new Error("关联 GitHub 失败");
  };

  return {
    url,
    identity,
    host,
    linkGitHub,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await close();
      await database.drop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
