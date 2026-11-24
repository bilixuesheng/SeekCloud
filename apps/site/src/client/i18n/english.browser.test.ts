import { sql } from "drizzle-orm";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreview } from "../../testing/preview-server";
import { createTestApp, type TestApp } from "../../testing/test-app";

/**
 * 英文界面的冒烟测试（#136）：浏览器语言是英文时，已经迁进文案目录的页面上看得到的文字和读屏文字里没有汉字。
 * 每迁完一批页面就在这里加上那几页。现在有：首页（问候语、等你输入的提示、输入框、"+"、环境、仓库、模型弹层）、
 * 侧栏（置顶、分组、最近、已归档）、账户菜单、会话菜单、分组菜单；会话页（假宿主机回放一个带工具调用和改动的回合：
 * 工具调用的摘要、展开的输入和结果、改动卡片和面板、会话信息）。
 * 设 SEEKCLOUD_BROWSER_TESTS=1 才跑，要先 pnpm build。
 */
describe.skipIf(!process.env.SEEKCLOUD_BROWSER_TESTS)(
  "英文界面没有中文（真的浏览器）",
  { timeout: 60_000 },
  () => {
    let t: TestApp;
    let preview: { url: string; close: () => Promise<void> };
    let browser: Browser;
    let page: Page;
    let sessionId: string;

    beforeAll(async () => {
      t = await createTestApp();
      const { browser: admin } = await t.adminWithGitHub("octo", "octo/app");
      // 测试的管理员默认叫"管理员"：昵称是管理员自己填的内容，换成英文的
      await admin.request("/api/me/nickname", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: "Ada" }),
      });
      // 第一个会话的回合：一段回复、读一个文件、跑一条命令、改了四个文件（Agent 的回复本身是英文的）
      t.host.script(
        { type: "message", text: "I will look at the project first." },
        { type: "tool.call", callId: "c1", name: "Read", input: { file_path: "src/app.ts" } },
        { type: "tool.result", callId: "c1", output: "export {}", isError: false },
        { type: "tool.call", callId: "c2", name: "Bash", input: { command: "pnpm test" } },
        { type: "tool.result", callId: "c2", output: "", isError: false },
        { type: "message", text: "The health check endpoint is in place." },
        {
          type: "workspace",
          repos: [
            {
              fullName: "octo/app",
              head: "a".repeat(40),
              push: "pushed",
              files: ["src/app.ts", "src/health.ts", "test/health.test.ts", "README.md"].map(
                (path) => ({ path, additions: 3, deletions: 1 }),
              ),
            },
          ],
        },
      );
      const ids: string[] = [];
      for (const text of [
        "Add a health check",
        "Fix the login test",
        "Upgrade packages",
        "Old work",
      ]) {
        const res = await admin.post("/api/sessions", {
          repo: "octo/app",
          baseBranch: "main",
          text,
        });
        ids.push(((await res.json()) as { shortId: string }).shortId);
      }
      await t.host.idle();
      sessionId = ids[0] as string;
      await admin.post(`/api/sessions/${ids[0]}/pin`, { pinned: true });
      const res = await admin.post("/api/session-groups", { name: "Backend" });
      const { id: groupId } = (await res.json()) as { id: string };
      await admin.post(`/api/sessions/${ids[1]}/place`, { section: "group", groupId, after: null });
      await admin.post(`/api/sessions/${ids[3]}/archive`, {});
      await t.db.execute(
        sql`update sessions set status = 'waiting', status_detail = 'awaiting_input' where short_id = ${ids[2]}`,
      );
      preview = await startPreview(t);
      browser = await chromium.launch(
        process.env.SEEKCLOUD_CHROMIUM ? { executablePath: process.env.SEEKCLOUD_CHROMIUM } : {},
      );
      page = await browser.newPage({
        viewport: { width: 390, height: 760 },
        hasTouch: true,
        isMobile: true,
        locale: "en-US",
      });
      await page.goto(preview.url);
      await page.evaluate(async (password) => {
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
      }, t.adminPassword);
      await page.goto(preview.url);
      await page.locator(".greeting h1").waitFor();
      await page.locator(".composer-below-options").waitFor();
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
      await preview?.close();
      await t?.close();
    });

    /** 页面上看得到的文字、读屏文字、提示和标题里的汉字。 */
    const han = () =>
      page.evaluate(() => {
        const attrs = ["aria-label", "title", "placeholder", "data-tip"];
        const labels = [...document.querySelectorAll(attrs.map((a) => `[${a}]`).join(","))].flatMap(
          (el) => attrs.map((a) => el.getAttribute(a) ?? ""),
        );
        // 只算看得见的文字（收起的弹层、读屏专用的隐藏文字不算），所以用 innerText
        // biome-ignore lint/performance/useDomNodeTextContent: 要的就是渲染出来的文字
        const text = [document.body.innerText, ...labels, document.title].join(" ");
        return [...text].filter((c) => /\p{Script=Han}/u.test(c)).join("");
      });

    const pause = () => page.waitForTimeout(400);

    it("首页：<html lang> 是英文，问候语、提示、输入框、环境和仓库都是英文", async () => {
      expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");
      // 会话列表是页面画出来以后才到的：之前提示收着，里面是"0 sessions…"，要等到列表到了再看
      const hint = page.locator(".awaiting-hint-text", { hasText: "Upgrade packages" });
      await hint.waitFor();
      expect(await hint.textContent()).toBe("Upgrade packages is waiting for your input");
      expect(await page.locator(".composer-below-options").textContent()).toContain("Default");
      expect(await han()).toBe("");
    });

    it("输入框的" + "、仓库弹层、模型弹层", async () => {
      await page.locator(".composer-attach").click();
      await pause();
      expect(await han()).toBe("");
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 300);
      await pause();
      await page.locator(".repo-chip").click();
      await pause();
      expect(await page.getByText("Manage repository access").count()).toBe(1);
      expect(await han()).toBe("");
      await page.locator(".repo-chip").click();
      await pause();
      await page.locator(".model-trigger").click();
      await pause();
      expect(await han()).toBe("");
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 300);
      await pause();
    });

    it("侧栏、账户菜单、会话菜单、分组菜单", async () => {
      await page.getByRole("button", { name: "Sessions", exact: true }).click();
      await page.locator("aside.sidebar.open").waitFor();
      await page.locator(".sidebar-archived-toggle").click();
      await pause();
      const sidebar = await page.locator("aside.sidebar").textContent();
      for (const heading of ["Pinned", "Backend", "Recent", "Archived"]) {
        expect(sidebar).toContain(heading);
      }
      expect(await han()).toBe("");

      await page.locator(".account-button").click();
      await pause();
      expect(await page.locator(".account-menu").textContent()).toContain("Sign out");
      expect(await han()).toBe("");
      await page.keyboard.press("Escape");
      await pause();

      await page.getByRole("button", { name: "Session options: Add a health check" }).click();
      await pause();
      expect(await page.locator("section.sheet").textContent()).toContain("Unpin");
      expect(await han()).toBe("");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(700);

      await page.getByRole("button", { name: "Group options: Backend" }).click();
      await pause();
      expect(await page.locator("section.sheet").textContent()).toContain("Delete group");
      expect(await han()).toBe("");
    });

    it("会话页：工具调用的摘要是英文整句，展开的输入和结果、改动卡片和面板、会话信息都是英文", async () => {
      await page.goto(`${preview.url}/s/${sessionId}`);
      await page.locator(".tool-group-text").waitFor();
      expect(await page.locator(".tool-group-text").textContent()).toBe(
        "Read 1 file and ran 1 command",
      );
      expect(await page.locator(".ai-notice").textContent()).toBe(
        "DeepSeek is AI and can make mistakes.",
      );
      expect(await page.locator(".changes-head").textContent()).toBe("Changed 4 files");
      expect(await page.locator(".changes-all").textContent()).toContain("See all");
      expect(await han()).toBe("");

      // 展开工具调用：每一次的名字、输入、结果（空的结果写 no output）
      await page.locator(".tool-group > summary").click();
      await page.locator(".tool-group-body .tool > summary").last().click();
      await pause();
      const body = (await page.locator(".tool-group-body").textContent()) ?? "";
      for (const text of ["Read", "Run", "Input", "Result", "(no output)"]) {
        expect(body).toContain(text);
      }
      expect(await han()).toBe("");

      await page.getByRole("button", { name: "Session info" }).click();
      await pause();
      expect(await page.locator(".session-info").textContent()).toContain("Default");
      expect(await han()).toBe("");
      await page.keyboard.press("Escape");
      await pause();

      await page.locator(".changes-all").click();
      await page.locator(".changes-panel.shown").waitFor();
      await pause();
      expect(await han()).toBe("");
    });

    it("设置：通用、模型、会话、GitHub、账户、数据每一类都是英文", async () => {
      for (const section of ["general", "model", "sessions", "github", "account", "data"]) {
        await page.goto(`${preview.url}/settings/${section}`);
        await page.locator(".settings-content").waitFor();
        await page.waitForTimeout(600);
        expect(await han(), section).toBe("");
      }
      // 账户里的弹窗：修改密码、退出所有设备的确认
      await page.goto(`${preview.url}/settings/account`);
      await page.locator(".settings-content").waitFor();
      await page.waitForTimeout(600);
      await page.getByRole("button", { name: "Change", exact: true }).last().click();
      await pause();
      expect(await page.locator(".modal-title").last().textContent()).toContain(
        "Change admin password",
      );
      expect(await han()).toBe("");
      await page.keyboard.press("Escape");
      await pause();
      await page.getByRole("button", { name: "Sign out everywhere" }).click();
      await pause();
      expect(await han()).toBe("");
      await page.keyboard.press("Escape");
      await pause();
    });

    it("设置的模型：内置的 DeepSeek 按界面语言写名字；管理模型、编辑一个模型、添加模型提供商的弹窗都是英文", async () => {
      await page.goto(`${preview.url}/settings/model`);
      await page.locator(".provider-card").first().waitFor();
      await page.waitForTimeout(600);
      expect(await page.locator(".provider-card").first().textContent()).toContain("DeepSeek");
      await page.getByRole("button", { name: "Manage models" }).first().click();
      await pause();
      expect(await page.locator(".modal-title").last().textContent()).toBe("DeepSeek models");
      expect(await han()).toBe("");
      // 打开一个模型的编辑弹窗（叠在上面）
      await page.locator(".model-row-main").first().click();
      await pause();
      expect(await han()).toBe("");
      await page.keyboard.press("Escape");
      await pause();
      await page.keyboard.press("Escape");
      await pause();
      await page.getByRole("button", { name: "Add model provider" }).click();
      await pause();
      expect(await han()).toBe("");
      // 自定义模型 API 那一页
      await page.getByText("Custom model API", { exact: true }).click();
      await pause();
      expect(await han()).toBe("");
      await page.keyboard.press("Escape");
      await pause();
    });

    it("开源声明页：只有附加条款规定的署名是中文原文，后面附英文说明", async () => {
      await page.goto(`${preview.url}/licenses`);
      await page.locator(".legal-body").waitFor();
      expect(await han()).toBe("基于");
      expect(await page.locator(".legal-body").textContent()).toContain("(Based on SeekCloud)");
    });
  },
);
