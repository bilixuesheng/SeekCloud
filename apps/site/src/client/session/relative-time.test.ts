import { describe, expect, it } from "vitest";
import { fullTime, relativeTime } from "./relative-time";

// 都用本地时间构造，测试不受时区影响。
const now = new Date(2026, 10, 1, 20, 2, 30);

describe("消息下面的时间", () => {
  it("一分钟内是刚刚；本机时钟慢一点、时间在未来也算刚刚", () => {
    expect(relativeTime(new Date(2026, 10, 1, 20, 2, 0), now)).toBe("刚刚");
    expect(relativeTime(new Date(2026, 10, 1, 20, 2, 40), now)).toBe("刚刚");
  });

  it("一小时内按分钟", () => {
    expect(relativeTime(new Date(2026, 10, 1, 20, 1, 30), now)).toBe("1 分钟前");
    expect(relativeTime(new Date(2026, 10, 1, 19, 3, 0), now)).toBe("59 分钟前");
  });

  it("今天、昨天写几点几分", () => {
    expect(relativeTime(new Date(2026, 10, 1, 9, 5), now)).toBe("今天 09:05");
    expect(relativeTime(new Date(2026, 9, 31, 23, 59), now)).toBe("昨天 23:59");
  });

  it("更早的写日期；不是今年的写全年份", () => {
    expect(relativeTime(new Date(2026, 9, 30, 8, 0), now)).toBe("10月30日 08:00");
    expect(relativeTime(new Date(2025, 11, 31, 8, 0), now)).toBe("2025年12月31日");
  });

  it("完整时间带秒", () => {
    expect(fullTime(new Date(2026, 10, 1, 9, 5, 7))).toBe("2026年11月1日 09:05:07");
  });
});
