import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeUser } from "../testing/fake-github";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";
import { AI_NOTICE } from "./account/transcript";
import { sessions } from "./db/schema";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** 用 GitHub 登录（假 GitHub 上已经同意授权），返回跳回来时要去的地址。 */
async function githubSignIn(t: TestApp, browser: TestBrowser, user: FakeUser) {
  const start = await browser.get("/api/auth/github/start");
  const state = new URL(start.headers.get("location") as string).searchParams.get("state");
  const callback = await browser.get(
    `/api/auth/github/callback?code=${t.github.authorize(user)}&state=${state}`,
  );
  return callback.headers.get("location");
}

/** 用 GitHub 注册，发起一个会话并等 Agent 回完。 */
async function userWithSession(t: TestApp, login: string, text: string) {
  const { browser, user } = await t.signUpWithGitHub(login, `${login}/app`);
  t.host.script(
    { type: "message", text: "先看一下代码。", thinking: "要找到入口文件" },
    { type: "tool.call", callId: "c1", name: "Bash", input: { command: "echo ```" } },
    { type: "tool.result", callId: "c1", output: "```", isError: false },
    { type: "message", text: "改好了。" },
  );
  const res = await browser.post("/api/sessions", {
    repo: `${login}/app`,
    baseBranch: "main",
    text,
  });
  const { shortId } = (await res.json()) as { shortId: string };
  await t.host.idle();
  return { browser, user, shortId, email: `${login}@example.com` };
}

describe("导出数据", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("申请后由后台任务打包，好了发邮件；压缩包里有账户资料、环境、每个会话的 JSON 和 Markdown，没有令牌", async () => {
    const { browser, shortId, email } = await userWithSession(t, "exporter", "把登录页改一下");

    const requested = await browser.post("/api/account/export", {});
    expect(requested.status).toBe(202);
    expect(await json(requested)).toMatchObject({ latest: { status: "pending", expiresAt: null } });

    await t.runMaintenance();

    const overview = await json(await browser.get("/api/account/export"));
    const latest = overview.latest as { id: string; status: string; expiresAt: string };
    expect(latest.status).toBe("ready");
    expect(new Date(latest.expiresAt).getTime()).toBe(t.clock.now().getTime() + DAY);
    const mail = t.mailer.sent.findLast((m) => m.to === email);
    expect(mail?.subject).toBe("SeekCloud：数据导出已完成");
    expect(mail?.text).toContain("https://seekcloud.test/settings/privacy");

    const download = await browser.get(`/api/account/export/${latest.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/zip");
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; filename="seekcloud-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
    // 去掉目录本身（sessions/）的条目，只看文件。
    expect(
      Object.keys(files)
        .filter((name) => !name.endsWith("/"))
        .sort(),
    ).toEqual([
      "README.txt",
      "account.json",
      "environments.json",
      `sessions/${shortId}.json`,
      `sessions/${shortId}.md`,
    ]);
    const text = (name: string) => strFromU8(files[name] as Uint8Array);
    expect(text("README.txt").split("\n")[0]).toBe("SeekCloud · 数据导出");
    expect(JSON.parse(text("account.json"))).toMatchObject({
      email,
      identities: [{ provider: "github", login: "exporter" }],
    });
    expect(JSON.parse(text("environments.json"))).toEqual([
      expect.objectContaining({ isDefault: true }),
    ]);
    const session = JSON.parse(text(`sessions/${shortId}.json`)) as {
      aiNotice: string;
      title: string;
      events: Array<{ type: string; text?: string; aiGenerated?: boolean }>;
    };
    expect(session.events.filter((e) => e.type === "message").map((e) => e.text)).toEqual([
      "先看一下代码。",
      "改好了。",
    ]);
    // AI 生成的标识：JSON 开头有说明、Agent 的消息带标识字段，Markdown 和 README 里也有
    expect(session.aiNotice).toBe(AI_NOTICE);
    expect(session.events.filter((e) => e.aiGenerated).map((e) => e.type)).toEqual([
      "message",
      "message",
    ]);
    expect(text(`sessions/${shortId}.md`)).toContain(AI_NOTICE);
    expect(text("README.txt")).toContain(AI_NOTICE);
    const markdown = text(`sessions/${shortId}.md`);
    expect(markdown).toContain("把登录页改一下");
    expect(markdown).toContain("> 要找到入口文件");
    // 输出里有 ```：围栏要更长，代码块不会提前结束。
    expect(markdown).toContain("````\n```\n````");
    // GitHub 令牌（假 GitHub 发的是 gho_ 开头）不能出现在任何文件里。
    for (const name of Object.keys(files)) {
      if (!name.endsWith("/")) expect(text(name)).not.toContain("gho_");
    }
  });

  it("每 24 小时只能申请一次；满 24 小时后可以再申请", async () => {
    const { browser } = await t.signUpWithGitHub("twice", "twice/app");
    expect((await browser.post("/api/account/export", {})).status).toBe(202);

    t.clock.advance(23 * HOUR);
    const again = await browser.post("/api/account/export", {});
    expect(again.status).toBe(429);
    expect(await errorCode(again)).toBe("export_too_soon");
    expect(Number(again.headers.get("retry-after"))).toBe(3600);
    const overview = await json(await browser.get("/api/account/export"));
    expect(overview.nextAvailableAt).toBe(new Date(t.clock.now().getTime() + HOUR).toISOString());

    t.clock.advance(HOUR);
    expect((await browser.post("/api/account/export", {})).status).toBe(202);
  });

  it("下载链接 24 小时后失效，压缩包也删掉；别人的导出下载不了", async () => {
    const { browser } = await t.signUpWithGitHub("expiring", "expiring/app");
    const other = (await t.signUpWithGitHub("someone", "someone/app")).browser;
    await browser.post("/api/account/export", {});
    await t.runMaintenance();
    const { id } = (await json(await browser.get("/api/account/export"))).latest as { id: string };
    const path = `/api/account/export/${id}/download`;

    expect((await other.get(path)).status).toBe(404);
    expect((await t.browser().get(path)).status).toBe(401);
    expect((await browser.get(path)).status).toBe(200);

    t.clock.advance(DAY + 1000);
    expect((await browser.get(path)).status).toBe(404);
    await t.runMaintenance();
    expect((await json(await browser.get("/api/account/export"))).latest).toMatchObject({
      status: "expired",
    });
  });

  it("打包失败：标成失败，不算进 24 小时一次，可以马上重试", async () => {
    const { browser } = await t.signUpWithGitHub("broken", "broken/app");
    // 放一个同名文件挡住 exports 目录，写压缩包时就会失败。
    const blocker = join(t.dataDir, "exports");
    await rm(blocker, { recursive: true, force: true });
    await writeFile(blocker, "");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    await browser.post("/api/account/export", {});
    await t.runMaintenance();
    quiet.mockRestore();
    await rm(blocker, { force: true });

    expect((await json(await browser.get("/api/account/export"))).latest).toMatchObject({
      status: "failed",
    });
    expect((await browser.post("/api/account/export", {})).status).toBe(202);
    await t.runMaintenance();
    expect((await json(await browser.get("/api/account/export"))).latest).toMatchObject({
      status: "ready",
    });
  });
});

describe("删除账户", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  /** 发删除验证码，返回邮件里的验证码。 */
  async function deletionCode(browser: TestBrowser, email: string) {
    t.clock.advance(2 * 60_000); // 避开每分钟一次的限制
    expect((await browser.post("/api/account/delete/send-code", {})).status).toBe(204);
    const mail = t.mailer.sent.findLast((m) => m.to === email);
    expect(mail?.subject).toBe("SeekCloud：确认删除账户");
    return t.lastLoginCode(email);
  }

  it("验证码确认后立即停用：所有设备退出，会话归档并删沙箱，邮箱和 GitHub 账号可以重新注册；不碰 GitHub", async () => {
    const { browser, user, email } = await userWithSession(t, "leaver", "随便改改");
    // 另一台设备上也登录着。
    const phone = t.browser();
    expect(await githubSignIn(t, phone, user)).toBe("/");
    expect((await phone.get("/api/me")).status).toBe(200);

    const code = await deletionCode(browser, email);
    const wrong = await browser.post("/api/account/delete", {
      code: code === "000000" ? "111111" : "000000",
    });
    expect(wrong.status).toBe(400);
    expect(await errorCode(wrong)).toBe("invalid_code");

    // 删除过程中不调用 GitHub 的任何接口。
    const github = t.github as unknown as Record<string, unknown>;
    const spies = Object.getOwnPropertyNames(Object.getPrototypeOf(t.github))
      .filter((name) => name !== "constructor" && typeof github[name] === "function")
      .map((name) => vi.spyOn(t.github, name as never));
    const commandsBefore = t.host.commands.length;

    const done = await browser.post("/api/account/delete", { code });
    expect(done.status).toBe(204);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    expect((await browser.get("/api/me")).status).toBe(401);
    expect((await phone.get("/api/me")).status).toBe(401);
    expect(t.mailer.sent.findLast((m) => m.to === email)?.subject).toBe("SeekCloud：账户已删除");

    // 会话归档，宿主机收到删沙箱的命令。
    const sessionId = t.host.commands.find((c) => c.type === "prepare_sandbox")?.sessionId;
    expect(t.host.commands.slice(commandsBefore)).toContainEqual({
      type: "destroy_sandbox",
      sessionId,
    });
    // 同一个 GitHub 账号再来：已经不属于任何账户，按陌生账号处理，可以注册新账户。
    const again = t.browser();
    expect(await githubSignIn(t, again, user)).toBe("/?signin=pending");
    expect(await json(await again.get("/api/auth/pending"))).toMatchObject({ canRegister: true });

    // 原来的邮箱再登录：要邀请码，也就是可以重新注册。
    t.clock.advance(13 * 60_000);
    await again.post("/api/auth/email/send-code", { email });
    const relogin = await again.post("/api/auth/email/verify", {
      email,
      code: t.lastLoginCode(email),
    });
    expect(await errorCode(relogin)).toBe("invite_required");
  });

  it("验证码最多试 5 次", async () => {
    const { browser } = await t.signUpWithGitHub("guesser", "guesser/app");
    const code = await deletionCode(browser, "guesser@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await browser.post("/api/account/delete", { code: wrong });
    expect((await browser.post("/api/account/delete", { code })).status).toBe(400);
    expect((await browser.get("/api/me")).status).toBe(200);
  });

  it("停用满 14 天，清理任务删掉整个账户：会话、环境、导出的压缩包", async () => {
    const { browser, shortId, email } = await userWithSession(t, "purged", "最后一次");
    await browser.post("/api/account/export", {});
    await t.runMaintenance();
    const { id } = (await json(await browser.get("/api/account/export"))).latest as { id: string };
    const zip = join(t.dataDir, "exports", `${id}.zip`);
    expect((await stat(zip)).size).toBeGreaterThan(0);

    const code = await deletionCode(browser, email);
    expect((await browser.post("/api/account/delete", { code })).status).toBe(204);
    const sessionRows = () => t.db.select().from(sessions).where(eq(sessions.shortId, shortId));
    // 停用以后会话还在（等清理），但已经归档。
    expect((await sessionRows())[0]?.status).toBe("archived");

    t.clock.advance(13 * DAY);
    await t.runMaintenance();
    expect(await sessionRows()).toHaveLength(1);

    t.clock.advance(DAY + 60_000);
    await t.runMaintenance();
    expect(await sessionRows()).toHaveLength(0);
    await expect(stat(zip)).rejects.toThrow();
  });
});
