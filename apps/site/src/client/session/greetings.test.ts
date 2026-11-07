import { describe, expect, it } from "vitest";
import { pickGreeting } from "./greetings";

describe("新会话页的问候语", () => {
  it("随机挑一句；有的句子只在对应的时间出现", () => {
    const lateNight = new Date(2026, 10, 2, 2, 0); // 周一凌晨 2 点
    const morning = new Date(2026, 10, 2, 9, 0);
    const last = () => 0.999;

    expect(pickGreeting(lateNight, last)).toBe("夜深，仍在求索");
    expect(pickGreeting(morning, last)).toBe("新的一天，从何开始？");
    expect(pickGreeting(new Date(2026, 10, 1, 9, 0), last)).toBe("周末愉快"); // 周日
    expect(pickGreeting(morning, () => 0)).toBe("今日有何计划？");
  });
});
