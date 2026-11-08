import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import { AI_NOTICE } from "./account/transcript";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** 管理员关联 GitHub，发起一个会话并等 Agent 回完。 */
async function adminWithSession(t: TestApp, login: string, text: string) {
  const { browser } = await t.adminWithGitHub(login, `${login}/app`);
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
  return { browser, shortId };
}

describe("导出数据", () => {
  let t: TestApp;

  // 每 24 小时只能导出一次，而管理员只有一个：每个用例一个新的主站。
  beforeEach(async () => {
    await t?.close();
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("申请后由后台任务打包，好了在设置里下载；压缩包里有账户资料、环境、每个会话的 JSON 和 Markdown，没有令牌", async () => {
    const { browser, shortId } = await adminWithSession(t, "exporter", "把登录页改一下");

    const requested = await browser.post("/api/account/export", {});
    expect(requested.status).toBe(202);
    expect(await json(requested)).toMatchObject({ latest: { status: "pending", expiresAt: null } });

    await t.runMaintenance();

    const overview = await json(await browser.get("/api/account/export"));
    const latest = overview.latest as { id: string; status: string; expiresAt: string };
    expect(latest.status).toBe("ready");
    expect(new Date(latest.expiresAt).getTime()).toBe(t.clock.now().getTime() + DAY);

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
    expect(text("README.txt").split("\n").slice(0, 3)).toEqual([
      "SeekCloud · 数据导出",
      "",
      "账户：exporter",
    ]);
    expect(JSON.parse(text("account.json"))).toEqual({
      createdAt: expect.any(String),
      github: "exporter",
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

  it("没关联 GitHub：账户写作管理员", async () => {
    const browser = await t.admin();
    await browser.post("/api/account/export", {});
    await t.runMaintenance();
    const { id } = (await json(await browser.get("/api/account/export"))).latest as { id: string };

    const download = await browser.get(`/api/account/export/${id}/download`);

    const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
    expect(strFromU8(files["README.txt"] as Uint8Array)).toContain("账户：管理员\n");
    expect(JSON.parse(strFromU8(files["account.json"] as Uint8Array))).toMatchObject({
      github: null,
    });
  });

  it("每 24 小时只能申请一次；满 24 小时后可以再申请", async () => {
    const browser = await t.admin();
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

  it("下载链接 24 小时后失效，压缩包也删掉；没登录下载不了", async () => {
    const browser = await t.admin();
    await browser.post("/api/account/export", {});
    await t.runMaintenance();
    const { id } = (await json(await browser.get("/api/account/export"))).latest as { id: string };
    const path = `/api/account/export/${id}/download`;

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
    const browser = await t.admin();
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
