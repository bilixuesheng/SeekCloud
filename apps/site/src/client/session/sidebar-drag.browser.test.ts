import type { Session, SessionGroup } from "@seekcloud/protocol";
import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreview } from "../../testing/preview-server";
import { createTestApp, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";

/**
 * 侧栏的拖动和手势（#153），在真的浏览器里用触摸和鼠标测。
 * 设 SEEKCLOUD_BROWSER_TESTS=1 才跑，要先 pnpm build（CI 的 browser 那一项就是这么跑的）。
 */
describe.skipIf(!process.env.SEEKCLOUD_BROWSER_TESTS)(
  "侧栏的拖动（真的浏览器）",
  { timeout: 30_000 },
  () => {
    let t: TestApp;
    let admin: TestBrowser;
    let preview: { url: string; close: () => Promise<void> };
    let browser: Browser;
    let page: Page;
    let cdp: CDPSession;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      t = await createTestApp();
      ({ browser: admin } = await t.adminWithGitHub("octo", "octo/app"));
      for (const title of [
        "甲会话",
        "乙会话",
        "丙会话",
        "丁会话",
        "戊会话",
        "己会话",
        "庚会话",
        "辛会话",
      ]) {
        t.clock.advance(60_000);
        const res = await admin.post("/api/sessions", {
          repo: "octo/app",
          baseBranch: "main",
          text: title,
        });
        ids[title] = ((await res.json()) as { shortId: string }).shortId;
        await t.host.idle();
      }
      preview = await startPreview(t);
      browser = await chromium.launch(
        process.env.SEEKCLOUD_CHROMIUM ? { executablePath: process.env.SEEKCLOUD_CHROMIUM } : {},
      );
      page = await browser.newPage({
        viewport: { width: 390, height: 640 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 1,
      });
      cdp = await page.context().newCDPSession(page);
      await page.goto(preview.url);
      await page.evaluate(async (password) => {
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
      }, t.adminPassword);
      await page.goto(preview.url);
      await openDrawer();
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
      await preview?.close();
      await t?.close();
    });

    const openDrawer = async () => {
      await page.getByRole("button", { name: "会话列表", exact: true }).click();
      await page.locator("aside.sidebar.open").waitFor();
      await page.waitForTimeout(400);
    };
    const sessions = async () =>
      ((await (await admin.get("/api/sessions")).json()) as { sessions: Session[] }).sessions;
    const find = async (title: string) =>
      (await sessions()).find((s) => s.shortId === ids[title]) as Session;
    const center = async (selector: string) => {
      const el = page.locator(selector).first();
      // 滚到看得见的地方；换了位置的会话会滑过去（useFlip）：等滑完再量，不然手指按在别的会话上
      await el.scrollIntoViewIfNeeded();
      await el.evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished)));
      const box = await el.boundingBox();
      if (!box) throw new Error(`找不到 ${selector}`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const item = (title: string) => `li[data-session="${ids[title]}"]`;

    /** 一根手指按下、按顺序经过这些点、松开。经过 CDP 发真的触摸事件。 */
    const touchPath = async (points: Array<{ x: number; y: number }>, holdMs = 0) => {
      const [first, ...rest] = points;
      if (!first) return;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: first.x, y: first.y }],
      });
      for (const p of rest) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: p.x, y: p.y }],
        });
        await page.waitForTimeout(16);
      }
      if (holdMs) await page.waitForTimeout(holdMs);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(300);
    };
    /** 从 from 出发：先横着走 dx（判成拖动），再走到 to。 */
    const steps = (from: { x: number; y: number }, to: { x: number; y: number }, n = 12) =>
      Array.from({ length: n + 1 }, (_, i) => ({
        x: from.x + ((to.x - from.x) * i) / n,
        y: from.y + ((to.y - from.y) * i) / n,
      }));

    it("先竖着滑：是滚动，不会变成拖动", async () => {
      const start = await center(item("丁会话"));
      await touchPath(steps(start, { x: start.x + 4, y: start.y - 160 }));
      expect(await page.locator(".drag-ghost").count()).toBe(0);
      expect((await find("丁会话")).pinnedAt).toBeNull();
      // 手指离开以后列表还会惯性滚一会儿：等它停下，免得后面量的位置不准
      await page.waitForTimeout(1500);
      expect(await page.locator("aside.sidebar.open").count()).toBe(1);
    });

    it("先横着走进入拖动：顶上出现“拖到这里置顶”，底部浮出“新分组”；拖进去松手就置顶", async () => {
      await page.locator(".sidebar-list").evaluate((el) => {
        el.scrollTop = 0;
      });
      const start = await center(item("丙会话"));
      const sideways = { x: start.x + 30, y: start.y + 2 };
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: start.x, y: start.y }],
      });
      for (const p of steps(start, sideways, 6)) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
        await page.waitForTimeout(16);
      }
      await page.locator(".drag-ghost").waitFor();
      expect(await page.locator(".sidebar-drop-zone").textContent()).toBe("拖到这里置顶");
      expect(await page.locator(".sidebar-new-group").count()).toBe(1);
      // 侧栏跟着手指往右挪了一点
      const shifted = await page.locator("aside.sidebar").evaluate((el) => el.style.transform);
      expect(shifted).toMatch(/translateX\(\d/);
      const zone = await center(".sidebar-drop-zone");
      for (const p of steps(sideways, zone, 10)) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(500);
      expect((await find("丙会话")).pinnedAt).not.toBeNull();
      // 松手以后侧栏弹回原位，不收起
      expect(await page.locator("aside.sidebar.open").count()).toBe(1);
      await page.locator('[data-drop="pinned"] li').filter({ hasText: "丙会话" }).waitFor();
    });

    it("从置顶里拖出来：手指旁边出现“松手取消置顶”，松手回到“最近”", async () => {
      // 拖到"最近"的第一个会话上：和置顶的丙挨着，不用滚动
      const target = await center(item("辛会话"));
      const start = await center(item("丙会话"));
      const sideways = { x: start.x + 30, y: start.y };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
      for (const p of [...steps(start, sideways, 5), ...steps(sideways, target, 10)]) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
        await page.waitForTimeout(16);
      }
      await page.locator(".drag-unpin").waitFor({ timeout: 5000 });
      expect(await page.locator(".drag-unpin").textContent()).toBe("松手取消置顶");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(500);
      expect((await find("丙会话")).pinnedAt).toBeNull();
      expect((await find("丙会话")).groupId).toBeNull();
    });

    it("拖到“新分组”上松手：建一个分组把会话放进去，名字马上可以改", async () => {
      const start = await center(item("乙会话"));
      const sideways = { x: start.x + 30, y: start.y };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
      for (const p of steps(start, sideways, 5)) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
        await page.waitForTimeout(16);
      }
      await page.locator(".sidebar-new-group").waitFor();
      const zone = await center(".sidebar-new-group");
      for (const p of steps(sideways, zone, 10)) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
        await page.waitForTimeout(16);
      }
      expect(await page.locator(".sidebar-new-group.active").count()).toBe(1);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      const input = page.getByRole("textbox", { name: "分组名" });
      await input.waitFor();
      await input.fill("界面");
      await input.press("Enter");
      await page.waitForTimeout(500);
      const { groups } = (await (await admin.get("/api/session-groups")).json()) as {
        groups: SessionGroup[];
      };
      expect(groups.map((g) => g.name)).toEqual(["界面"]);
      expect((await find("乙会话")).groupId).toBe(groups[0]?.id);
    });

    it("全屏的侧栏往左滑：侧栏跟着手指走；滑得不够就弹回，拖过一半就收起", async () => {
      const head = await center(".sidebar-head");
      const from = { x: 330, y: head.y };
      const transform = () =>
        page.locator("aside.sidebar").evaluate((el) => (el as HTMLElement).style.transform);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
      for (const p of steps(from, { x: from.x - 80, y: from.y }, 6)) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
        await page.waitForTimeout(16);
      }
      expect(await transform()).toMatch(/translateX\(-\d/);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(600);
      expect(await page.locator("aside.sidebar.open").count()).toBe(1);
      expect(await transform()).toBe("");

      await touchPath(steps(from, { x: 20, y: from.y + 4 }, 14));
      await page.waitForTimeout(300);
      expect(await page.locator("aside.sidebar.open").count()).toBe(0);
    });

    it("电脑上按住鼠标一动就是拖动：在“最近”里调顺序", async () => {
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForTimeout(300);
      const from = await center(item("甲会话"));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x, from.y - 10, { steps: 3 });
      await page.locator(".drag-ghost").waitFor();
      // 拖动一开始顶上多了"拖到这里置顶"，下面的会话都往下挪了：等它挪完再量
      await page.waitForTimeout(400);
      const to = await center(item("戊会话"));
      await page.mouse.move(to.x, to.y + 6, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(500);
      const recent = (await sessions())
        .filter((s) => s.pinnedAt === null && s.groupId === null)
        .sort((a, b) => b.sortKey - a.sortKey)
        .map((s) => s.shortId);
      expect(recent.indexOf(ids.甲会话 as string)).toBe(recent.indexOf(ids.戊会话 as string) + 1);
    });
  },
);
