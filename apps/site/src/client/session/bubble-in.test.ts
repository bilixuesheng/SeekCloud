import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUBBLE_IN_MS, catchUpBubble } from "./bubble-in";

const sentAt = "2026-11-08T08:00:00.000Z";
const later = (ms: number) => Date.parse(sentAt) + ms;

describe("服务器确认后换上来的气泡", () => {
  it("出现的动画还没播完，从当前进度接着播", () => {
    expect(catchUpBubble(sentAt, later(100))).toEqual({
      className: "bubble-in",
      style: { animationDelay: "-100ms" },
    });
  });

  it("已经播完就不再播", () => {
    expect(catchUpBubble(sentAt, later(BUBBLE_IN_MS))).toBeUndefined();
    expect(catchUpBubble(sentAt, later(5000))).toBeUndefined();
  });

  it("本机时钟往回调了也从头播，不会算出正的延迟", () => {
    expect(catchUpBubble(sentAt, later(-50))?.style.animationDelay).toBe("0ms");
  });

  it("时长和 styles.css 里的动画一致", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const duration = Number(css.match(/bubble-in ([\d.]+)s/)?.[1]) * 1000;
    expect(duration).toBe(BUBBLE_IN_MS);
  });
});
