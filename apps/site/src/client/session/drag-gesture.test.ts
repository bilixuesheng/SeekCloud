import { describe, expect, it } from "vitest";
import {
  autoScrollSpeed,
  classifyGesture,
  type DropZone,
  dropTarget,
  rubberBand,
  shouldClose,
} from "./drag-gesture";

const touch = (dx: number, dy: number, onSession = true, canSwipeClose = true) =>
  classifyGesture(dx, dy, "touch", { onSession, canSwipeClose });

describe("拖动的判定", () => {
  it("手机：走得不够远还没定；先竖着走是滚动；斜着走也是滚动", () => {
    expect(touch(4, 3)).toBe("pending");
    expect(touch(2, 12)).toBe("scroll");
    expect(touch(12, 10)).toBe("scroll");
    expect(touch(-12, 10)).toBe("scroll");
  });

  it("手机：在会话上先往右横着走是拖动；往左是把全屏侧栏拖回去（不全屏时往左也是拖动）", () => {
    expect(touch(12, 2)).toBe("drag");
    expect(touch(-12, 2)).toBe("swipe-close");
    expect(touch(-12, 2, true, false)).toBe("drag");
  });

  it("手机：不在会话上，往左是收侧栏，往右什么都不做（交给浏览器）", () => {
    expect(touch(-12, 1, false)).toBe("swipe-close");
    expect(touch(12, 1, false)).toBe("scroll");
    expect(touch(-12, 1, false, false)).toBe("scroll");
  });

  it("电脑：按住在会话上一动就是拖动，往哪边都行", () => {
    const mouse = (dx: number, dy: number, onSession = true) =>
      classifyGesture(dx, dy, "mouse", { onSession, canSwipeClose: false });
    expect(mouse(2, 2)).toBe("pending");
    expect(mouse(0, 6)).toBe("drag");
    expect(mouse(-6, 0)).toBe("drag");
    expect(mouse(0, 20, false)).toBe("pending");
  });

  it("全屏侧栏松手时：拖过一半或者往左甩得够快就收起，否则弹回", () => {
    expect(shouldClose(-200, 0, 390)).toBe(true);
    expect(shouldClose(-100, -0.8, 390)).toBe(true);
    expect(shouldClose(-100, -0.1, 390)).toBe(false);
    expect(shouldClose(40, 0, 390)).toBe(false);
  });

  it("侧栏跟着手指动时越往外越吃力，不超过上限，方向不变", () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(30)).toBeGreaterThan(0);
    expect(rubberBand(30)).toBeLessThan(30);
    expect(rubberBand(10_000)).toBeLessThan(48);
    expect(rubberBand(-30)).toBe(-rubberBand(30));
  });
});

describe("放到哪里", () => {
  const zones: DropZone[] = [
    {
      id: "pinned",
      top: 0,
      bottom: 100,
      items: [
        { shortId: "p1", top: 20, bottom: 60 },
        { shortId: "p2", top: 60, bottom: 100 },
      ],
    },
    { id: "group:g1", top: 110, bottom: 160, items: [] },
    {
      id: "recent",
      top: 170,
      bottom: 300,
      items: [
        { shortId: "r1", top: 190, bottom: 230 },
        { shortId: "r2", top: 230, bottom: 270 },
      ],
    },
    { id: "new-group", top: 280, bottom: 320, floating: true, items: [] },
  ];

  it.each([
    [30, "pinned", null],
    [45, "pinned", "p1"],
    [95, "pinned", "p2"],
    [130, "group:g1", null],
    [200, "recent", null],
    [215, "recent", "r1"],
    [260, "recent", "r2"],
    [290, "new-group", null],
    [500, "new-group", null],
  ] as const)("y = %s → %s，放在 %s 下面", (y, zone, after) => {
    const target = dropTarget(
      y === 500 ? zones.map((z) => (z.floating ? { ...z, bottom: 600 } : z)) : zones,
      y,
    );
    expect(target).toMatchObject({ zone, after });
  });

  it("在所有块外面：取最近的一块", () => {
    expect(dropTarget(zones.slice(0, 3), 900)?.zone).toBe("recent");
    expect(dropTarget(zones.slice(0, 3), -50)?.zone).toBe("pinned");
    expect(dropTarget([], 10)).toBeUndefined();
  });

  it("靠近列表上下边时自己滚，越近越快", () => {
    expect(autoScrollSpeed(200, 0, 400)).toBe(0);
    expect(autoScrollSpeed(10, 0, 400)).toBeLessThan(0);
    expect(autoScrollSpeed(0, 0, 400)).toBeLessThan(autoScrollSpeed(30, 0, 400));
    expect(autoScrollSpeed(395, 0, 400)).toBeGreaterThan(0);
  });
});
