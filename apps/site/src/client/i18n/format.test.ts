import { afterEach, describe, expect, it } from "vitest";
import {
  fullTime,
  listTime,
  minutesParts,
  relativeTime,
  shortDateTime,
  waitedTime,
} from "./format";
import { resetForTests } from "./index";

// 都用本地时间构造，测试不受时区影响。
const now = new Date(2026, 10, 1, 20, 2, 30);

describe("消息下面的时间（中文）", () => {
  afterEach(() => resetForTests("zh-CN"));

  it("一分钟内是刚刚；本机时钟慢一点、时间在未来也算刚刚", () => {
    resetForTests("zh-CN");
    expect(relativeTime(new Date(2026, 10, 1, 20, 2, 0), now)).toBe("刚刚");
    expect(relativeTime(new Date(2026, 10, 1, 20, 2, 40), now)).toBe("刚刚");
  });

  it("一小时内按分钟", () => {
    resetForTests("zh-CN");
    expect(relativeTime(new Date(2026, 10, 1, 20, 1, 30), now)).toBe("1 分钟前");
    expect(relativeTime(new Date(2026, 10, 1, 19, 3, 0), now)).toBe("59 分钟前");
  });

  it("今天、昨天写几点几分", () => {
    resetForTests("zh-CN");
    expect(relativeTime(new Date(2026, 10, 1, 9, 5), now)).toBe("今天 09:05");
    expect(relativeTime(new Date(2026, 9, 31, 23, 59), now)).toBe("昨天 23:59");
  });

  it("更早的写日期；不是今年的写全年份", () => {
    resetForTests("zh-CN");
    expect(relativeTime(new Date(2026, 9, 30, 8, 0), now)).toBe("10月30日 08:00");
    expect(relativeTime(new Date(2025, 11, 31, 8, 0), now)).toBe("2025年12月31日");
  });

  it("完整时间带秒；设置页上的时间", () => {
    resetForTests("zh-CN");
    expect(fullTime(new Date(2026, 10, 1, 9, 5, 7))).toBe("2026年11月1日 09:05:07");
    expect(shortDateTime(new Date(2026, 10, 2, 20, 2))).toBe("11月2日 20:02");
  });

  it("会话列表：分钟、小时、天，更早的写日期", () => {
    resetForTests("zh-CN");
    const t0 = Date.parse("2026-11-10T12:00:00Z");
    expect(listTime("2026-11-10T11:59:40Z", t0)).toBe("刚刚");
    expect(listTime("2026-11-10T11:55:00Z", t0)).toBe("5 分钟前");
    expect(listTime("2026-11-10T09:00:00Z", t0)).toBe("3 小时前");
    expect(listTime("2026-11-08T12:00:00Z", t0)).toBe("2 天前");
    expect(listTime("2026-10-20T12:00:00Z", t0)).toBe("10/20");
    // 首页"有会话在等你输入"的列表：等了多久
    expect(waitedTime("2026-11-10T11:59:40Z", t0)).toBe("刚刚");
    expect(waitedTime("2026-11-10T11:55:00Z", t0)).toBe("等了 5 分钟");
    expect(waitedTime("2026-11-10T09:00:00Z", t0)).toBe("等了 3 小时");
    expect(waitedTime("2026-11-08T12:00:00Z", t0)).toBe("等了 2 天");
    expect(waitedTime("2026-10-20T12:00:00Z", t0)).toBe("10/20");
  });
});

describe("英文", () => {
  afterEach(() => resetForTests("zh-CN"));

  it("分单复数；日期写月份缩写；今天、昨天", () => {
    resetForTests("en");
    expect(relativeTime(new Date(2026, 10, 1, 20, 1, 30), now)).toBe("1 minute ago");
    expect(relativeTime(new Date(2026, 10, 1, 19, 3, 0), now)).toBe("59 minutes ago");
    expect(relativeTime(new Date(2026, 10, 1, 9, 5), now)).toBe("Today 09:05");
    expect(relativeTime(new Date(2026, 9, 31, 23, 59), now)).toBe("Yesterday 23:59");
    expect(relativeTime(new Date(2026, 9, 30, 8, 0), now)).toBe("Oct 30, 08:00");
    expect(relativeTime(new Date(2025, 11, 31, 8, 0), now)).toBe("Dec 31, 2025");
    const t0 = Date.parse("2026-11-10T12:00:00Z");
    expect(listTime("2026-11-10T11:00:00Z", t0)).toBe("1 hour ago");
    expect(listTime("2026-11-08T12:00:00Z", t0)).toBe("2 days ago");
    expect(waitedTime("2026-11-10T11:59:00Z", t0)).toBe("Waiting for 1 minute");
    expect(waitedTime("2026-11-10T09:00:00Z", t0)).toBe("Waiting for 3 hours");
    expect(waitedTime("2026-11-09T12:00:00Z", t0)).toBe("Waiting for 1 day");
    expect(waitedTime("2026-10-20T12:00:00Z", t0)).toBe("Oct 20");
  });

  it("时长拆成数字和单位，单位分单复数（设置里的分段选择）", () => {
    resetForTests("en");
    expect(minutesParts(1)).toEqual({ value: "1", unit: "minute" });
    expect(minutesParts(30)).toEqual({ value: "30", unit: "minutes" });
    resetForTests("zh-CN");
    expect(minutesParts(10)).toEqual({ value: "10", unit: "分钟" });
  });
});
