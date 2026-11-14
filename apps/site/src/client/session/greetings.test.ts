import { describe, expect, it } from "vitest";
import { greetingPool, pickGreeting } from "./greetings";

// 2026-11-02 是周一，11-07 是周六
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0);

describe("新会话页的问候语", () => {
  it("没设昵称时，没有一句带名字或占位符", () => {
    const pool = greetingPool(null, at(2, 9));
    expect(pool).toContain("吾将上下而求索");
    expect(pool.some((g) => g.includes("{name}") || g.includes("，null"))).toBe(false);
    expect(greetingPool("  ", at(2, 9))).toEqual(pool);
  });

  it("设了昵称时，有的带上昵称（去掉首尾空格），并且出现的机会是两倍", () => {
    const pool = greetingPool(" 雪生 ", at(2, 9));
    expect(pool).toContain("欢迎回来，雪生");
    expect(pool).toContain("早上好，雪生");
    expect(pool.filter((g) => g === "欢迎回来，雪生")).toHaveLength(2);
    expect(pool.some((g) => g.includes("{name}"))).toBe(false);
  });

  it("看时段：早上不出现晚上好；夜里跨过零点", () => {
    const morning = greetingPool("雪生", at(2, 9));
    expect(morning).toContain("早上好");
    expect(morning).not.toContain("晚上好");
    expect(greetingPool("雪生", at(2, 23))).toContain("夜深了，雪生");
    expect(greetingPool("雪生", at(2, 2))).toContain("星垂平野阔，月涌大江流");
    expect(greetingPool("雪生", at(2, 2))).not.toContain("早上好");
  });

  it("看星期几：只在当天出现", () => {
    const monday = greetingPool("雪生", at(2, 15));
    expect(monday).toContain("周一愉快，雪生");
    expect(monday).not.toContain("周二愉快，雪生");
    expect(monday).not.toContain("周末愉快");
    const saturday = greetingPool("雪生", at(7, 15));
    expect(saturday).toContain("周六愉快，雪生");
    expect(saturday).toContain("偷得浮生半日闲");
  });

  it("随机挑一句，总在当时能用的里面", () => {
    const now = at(2, 9);
    const pool = greetingPool("雪生", now);
    expect(pickGreeting({ name: "雪生", now, random: () => 0 })).toBe(pool[0]);
    expect(pickGreeting({ name: "雪生", now, random: () => 0.999 })).toBe(pool.at(-1));
  });
});
