import { sql } from "drizzle-orm";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreview } from "../../testing/preview-server";
import { createTestApp, type TestApp } from "../../testing/test-app";

/**
 * 英文界面的冒烟测试（#136）：浏览器语言是英文时，已经迁进文案目录的页面上看得到的文字和读屏文字里没有汉字。
 * 每迁完一批页面就在这里加上那几页。现在有：首页（问候语、等你输入的提示、输入框、"+"、环境、仓库、模型弹层）、
 * 侧栏（置顶、分组、最近、已归档）、账户菜单、会话菜单、分组菜单。
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

    beforeAll(async () => {
      t = await createTestApp();
      const { browser: admin } = await t.adminWithGitHub("octo", "octo/app");
      // 测试的管理员默认叫"管理员"：昵称是管理员自己填的内容，换成英文的
      await admin.request("/api/me/nickname", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: "Ada" }),
      });
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
      expect(await page.locator(".awaiting-hint-text").textContent()).toBe(
        "Upgrade packages is waiting for your input",
      );
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
  },
);
