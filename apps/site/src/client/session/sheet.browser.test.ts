import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreview } from "../../testing/preview-server";
import { createTestApp, type TestApp } from "../../testing/test-app";

/**
 * 底部弹层（Motion.tsx 的 Sheet）在真的浏览器里每一帧量位置：打开时从屏幕底下滑上来（每次都有动画），
 * 关的时候滑到连阴影都看不见了才拿掉（不在半路停住再一下子消失）。
 * 设 SEEKCLOUD_BROWSER_TESTS=1 才跑，要先 pnpm build。
 */
describe.skipIf(!process.env.SEEKCLOUD_BROWSER_TESTS)(
  "底部弹层的动画（真的浏览器）",
  { timeout: 60_000 },
  () => {
    let t: TestApp;
    let preview: { url: string; close: () => Promise<void> };
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
      t = await createTestApp();
      const { browser: admin } = await t.adminWithGitHub("octo", "octo/app");
      const res = await admin.post("/api/sessions", {
        repo: "octo/app",
        baseBranch: "main",
        text: "看看首页",
      });
      const { shortId } = (await res.json()) as { shortId: string };
      await t.host.idle();
      preview = await startPreview(t);
      browser = await chromium.launch(
        process.env.SEEKCLOUD_CHROMIUM ? { executablePath: process.env.SEEKCLOUD_CHROMIUM } : {},
      );
      page = await browser.newPage({
        viewport: { width: 390, height: 760 },
        hasTouch: true,
        isMobile: true,
        // 按中文断言（规格 #134：测试固定用中文跑）
        locale: "zh-CN",
      });
      await page.goto(preview.url);
      await page.evaluate(async (password) => {
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
      }, t.adminPassword);
      await page.goto(`${preview.url}/s/${shortId}`);
      await page.locator(".session-title-button:not([disabled])").waitFor();
      // 每一帧记下弹层的上边在哪（没有弹层时记 null）
      await page.evaluate(() => {
        const w = window as unknown as { sheetTrace: Array<number | null> };
        w.sheetTrace = [];
        const tick = () => {
          const el = document.querySelector("section.sheet");
          w.sheetTrace.push(el ? el.getBoundingClientRect().top : null);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
      await preview?.close();
      await t?.close();
    });

    const takeTrace = () =>
      page.evaluate(() => {
        const w = window as unknown as { sheetTrace: Array<number | null> };
        const trace = w.sheetTrace;
        w.sheetTrace = [];
        return trace;
      });

    it("连着开关几次：每次打开都从底下滑上来，每次关都滑到看不见才拿掉", async () => {
      const height = await page.evaluate(() => window.innerHeight);
      for (let round = 0; round < 5; round++) {
        await takeTrace();
        await page.locator(".session-title-button").click();
        await page.waitForTimeout(700);
        const opening = (await takeTrace()).filter((y): y is number => y !== null);
        const resting = opening.at(-1) as number;
        console.log("open", opening.slice(0, 12).map(Math.round).join(","));
        expect(resting, `第 ${round + 1} 次打开停在屏幕里`).toBeLessThan(height - 100);
        // 弹层一出现就在页面上的头几帧，要在停下的位置下面很多：是滑上来的，不是一下子出现的
        expect(Math.max(...opening.slice(0, 3)), `第 ${round + 1} 次打开有动画`).toBeGreaterThan(
          resting + 80,
        );

        await page.keyboard.press("Escape");
        await page.waitForTimeout(700);
        const closing = await takeTrace();
        const last = closing.filter((y): y is number => y !== null).at(-1) as number;
        console.log(
          "close",
          closing
            .slice(0, 30)
            .map((y) => (y === null ? "-" : Math.round(y)))
            .join(","),
        );
        expect(closing.at(-1), `第 ${round + 1} 次关掉以后拿掉了`).toBeNull();
        // 拿掉之前的最后一帧：弹层和上面的阴影（30 像素左右）都已经在屏幕外面
        expect(last, `第 ${round + 1} 次关的时候滑到底才拿掉`).toBeGreaterThanOrEqual(height + 30);
      }
    });
  },
);
