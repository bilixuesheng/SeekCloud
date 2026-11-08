import { describe, expect, it } from "vitest";
import { contentKey, ScrollFollower } from "./follow-scroll";
import { buildTimeline } from "./timeline";

/** 假的滚动区域：内容和区域的高度都可以改，scrollTop 照浏览器的规矩夹在 [0, 最大值] 里。 */
class FakeBox {
  #top = 0;
  constructor(
    public scrollHeight: number,
    public clientHeight = 500,
  ) {}
  get scrollTop() {
    return this.#top;
  }
  set scrollTop(value: number) {
    this.#top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  }
  get atBottom() {
    return this.scrollHeight - this.#top - this.clientHeight < 1;
  }
  /** 区域变矮或变高：scrollTop 不变，变高时浏览器把它夹回范围里。 */
  resize(clientHeight: number) {
    this.clientHeight = clientHeight;
    this.scrollTop = this.#top;
  }
}

function setup(height = 2000) {
  const box = new FakeBox(height);
  const away: boolean[] = [];
  const follower = new ScrollFollower(box, (a) => away.push(a));
  follower.toBottom();
  return { box, follower, away };
}

describe("会话页的滚动跟随", () => {
  it("打开会话停在最底下；在底部时新内容来了跟着往下走", () => {
    const { box, follower } = setup();
    expect(box.atBottom).toBe(true);
    box.scrollHeight += 300;
    follower.contentAdded();
    expect(box.atBottom).toBe(true);
  });

  it("用户往上翻以后，新内容不把页面拉回去；回到底部才恢复跟随", () => {
    const { box, follower, away } = setup();
    // 滚轮往上：不等 scroll 事件，马上停止跟随
    follower.wheeled(-40);
    box.scrollTop -= 400;
    follower.scrolled();
    expect(away).toEqual([true]);
    const top = box.scrollTop;
    box.scrollHeight += 300;
    follower.contentAdded();
    expect(box.scrollTop).toBe(top);

    // 自己滚回底部
    box.scrollTop = box.scrollHeight;
    follower.scrolled();
    expect(away).toEqual([true, false]);
    box.scrollHeight += 300;
    follower.contentAdded();
    expect(box.atBottom).toBe(true);
  });

  it("手指往下拖（往回看）马上停止跟随；往上拖（往底部走）不算", () => {
    const { box, follower } = setup();
    follower.dragged(-30);
    expect(follower.following).toBe(true);
    follower.dragged(12);
    expect(follower.following).toBe(false);
    box.scrollHeight += 200;
    follower.contentAdded();
    expect(box.atBottom).toBe(false);
  });

  it("点回到底部的按钮：回到底部并恢复跟随", () => {
    const { box, follower, away } = setup();
    follower.wheeled(-10);
    box.scrollTop = 100;
    follower.scrolled();
    follower.toBottom();
    expect(box.atBottom).toBe(true);
    expect(away).toEqual([true, false]);
  });

  it("展开卡片（内容长高，但不是新内容）不动滚动位置", () => {
    const { box, follower } = setup();
    box.scrollTop -= 600; // 往上翻到中间，点开一张卡片
    follower.scrolled();
    const top = box.scrollTop;
    box.scrollHeight += 400;
    // 不调用 contentAdded：展开卡片不改 contentKey（见下一组测试）
    follower.scrolled();
    expect(box.scrollTop).toBe(top);
  });

  it("在底部时收起卡片，浏览器把 scrollTop 往回夹：仍然在跟随", () => {
    const { box, follower } = setup();
    box.scrollHeight -= 300;
    follower.scrolled();
    expect(follower.following).toBe(true);
  });

  it("停在底部时输入法弹出（区域变矮）：贴回底部；收起时也还在底部，不闪回到底部的按钮", () => {
    const { box, follower, away } = setup();
    box.resize(200);
    follower.resized();
    expect(box.atBottom).toBe(true);

    box.resize(500);
    follower.resized();
    follower.scrolled(); // 变高时 scrollTop 被往回夹，随后来一个 scroll 事件
    expect(box.atBottom).toBe(true);
    expect(away).toEqual([]);
  });

  it("往上翻以后输入法弹出、收起：滚动位置不动", () => {
    const { box, follower } = setup();
    follower.wheeled(-40);
    box.scrollTop -= 600;
    follower.scrolled();
    const top = box.scrollTop;

    box.resize(200);
    follower.resized();
    expect(box.scrollTop).toBe(top);
    box.resize(500);
    follower.resized();
    expect(box.scrollTop).toBe(top);
    expect(follower.following).toBe(false);
  });
});

describe("有没有新内容", () => {
  const at = "2026-11-07T00:00:00.000Z";
  const base = [
    { seq: 1, at, type: "user.message", text: "看一下" },
    { seq: 2, at, type: "status", status: "running" },
    { seq: 3, at, type: "tool.call", callId: "a", name: "Read", input: { path: "a.ts" } },
  ] as const;
  // biome-ignore lint/suspicious/noExplicitAny: 测试里直接写事件
  const key = (events: readonly any[], extra = "") => contentKey(buildTimeline([...events]), extra);

  it("工具结果、新消息、状态变化、刚发出去的消息都算新内容", () => {
    const k = key(base);
    expect(
      key([...base, { seq: 4, at, type: "tool.result", callId: "a", output: "x", isError: false }]),
    ).not.toBe(k);
    expect(key([...base, { seq: 4, at, type: "message", text: "好" }])).not.toBe(k);
    expect(key([...base, { seq: 4, at, type: "status", status: "waiting" }])).not.toBe(k);
    expect(key(base, "pending:再看一下")).not.toBe(k);
  });

  it("同样的事件算出同样的指纹：时间刷新、展开卡片重新渲染时不会被当成新内容", () => {
    expect(key(base)).toBe(key(base));
  });
});
