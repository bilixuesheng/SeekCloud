import { afterEach, describe, expect, it, vi } from "vitest";
import { resetForTests } from "../i18n";
import { enGreetings } from "../i18n/greetings-en";
import { zhGreetings } from "../i18n/greetings-zh";
import {
  type GreetingSet,
  greetingPool,
  pickGreeting,
  prepareGreeting,
  takeGreeting,
} from "./greetings";

// 2026-11-02 是周一，11-07 是周六
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0);
/** 此刻可能挑出来的：池子里的，加上单独给机会的"吾将上下而求索"。 */
const possible = (name: string | null) => [...greetingPool(name, new Date()), "吾将上下而求索"];

describe("新会话页的问候语", () => {
  it("没设昵称时，没有一句带名字或占位符；每句不超过 14 个字", () => {
    const pool = greetingPool(null, at(2, 9));
    expect(pool.some((g) => g.includes("{name}") || g.includes("，null"))).toBe(false);
    expect(greetingPool("  ", at(2, 9))).toEqual(pool);
    for (const hour of [2, 9, 12, 15, 20, 23]) {
      for (const day of [2, 7, 8]) {
        for (const g of greetingPool(null, at(day, hour))) expect([...g].length).toBeLessThan(15);
      }
    }
  });

  it("设了昵称时，有的带上昵称（去掉首尾空格），每句机会一样", () => {
    const pool = greetingPool(" 雪生 ", at(2, 9));
    expect(pool).toContain("欢迎回来，雪生");
    expect(pool.filter((g) => g === "欢迎回来，雪生")).toHaveLength(1);
    expect(pool.some((g) => g.includes("{name}"))).toBe(false);
  });

  it("不再有早上好、中午好、下午好、晚上好；合在一起的那句拆开了", () => {
    const all = [2, 9, 12, 15, 20, 23].flatMap((h) => greetingPool("雪生", at(2, h)));
    for (const gone of ["早上好", "中午好", "下午好", "晚上好", "早上好，雪生", "晚上好，雪生"]) {
      expect(all).not.toContain(gone);
    }
    expect(all).toContain("路漫漫其修远兮");
    expect(all.some((g) => g.includes("路漫漫其修远兮，"))).toBe(false);
  });

  it("看时段：夜里跨过零点", () => {
    expect(greetingPool("雪生", at(2, 23))).toContain("夜深了，雪生");
    expect(greetingPool("雪生", at(2, 2))).toContain("星垂平野阔，月涌大江流");
    expect(greetingPool("雪生", at(2, 2))).not.toContain("一日之计在于晨");
    expect(greetingPool("雪生", at(2, 9))).toContain("一日之计在于晨");
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

  it("吾将上下而求索、你是某地人吗各占 20%，剩下的在其余句子里平均分", () => {
    const now = at(2, 9);
    const pool = greetingPool("雪生", now);
    const pick = (r: number, region?: string) =>
      pickGreeting({ name: "雪生", now, random: () => r, region });
    expect(pick(0)).toBe("吾将上下而求索");
    expect(pick(0.19)).toBe("吾将上下而求索");
    expect(pick(0.2, "JP")).toBe("你是日本人吗，雪生");
    expect(pick(0.39, "JP")).toBe("你是日本人吗，雪生");
    expect(pick(0.4, "JP")).toBe(pool[0]);
    expect(pick(0.999, "JP")).toBe(pool.at(-1));
    // 猜不出地区时，那 20% 分给其余的句子
    expect(pick(0.2)).toBe(pool[0]);
    expect(pick(0.999)).toBe(pool.at(-1));
    // 没设昵称时也没有"你是某地人吗"
    expect(pickGreeting({ now, random: () => 0.3, region: "JP" })).not.toContain("人吗");
    expect(pool).not.toContain("吾将上下而求索");
  });

  it("页面一打开先挑一句并开始拉字体；首页第一次显示用它；用掉以后在后台先挑好下一句、拉它的字体", async () => {
    vi.useFakeTimers();
    try {
      const preloaded: string[] = [];
      prepareGreeting("雪生", (text) => preloaded.push(text));
      expect(preloaded).toHaveLength(1);
      expect(takeGreeting("雪生")).toBe(preloaded[0]);
      // 下一句过一会儿才开始拉字体，不和这一次抢
      expect(preloaded).toHaveLength(1);
      vi.advanceTimersByTime(2000);
      expect(preloaded).toHaveLength(2);
      // 重进首页用的就是先拉好字体的那句
      expect(takeGreeting("雪生")).toBe(preloaded[1]);
      expect(possible("雪生")).toContain(preloaded[1]);

      // 昵称变了：先挑的那句作废，现挑一句
      const other = takeGreeting("求索者");
      expect(possible("求索者")).toContain(other);
      expect(possible(null)).toContain(takeGreeting(null));
    } finally {
      vi.useRealTimers();
    }
  });

  describe("英文另写一套（#136）", () => {
    afterEach(() => resetForTests("zh-CN"));

    /** 所有时段、星期几下可能出现的不带昵称的句子。 */
    const everyPlain = (set: GreetingSet) =>
      [0, 2, 5, 9, 12, 15, 18, 20, 23].flatMap((hour) =>
        [1, 2, 3, 4, 5, 6, 7].flatMap((day) => greetingPool(null, at(day, hour), set)),
      );

    it("每种语言：不带昵称的句子不超过一行放得下的长度，带昵称的都有 {name}，没有重复的", () => {
      for (const set of [zhGreetings, enGreetings]) {
        for (const g of [set.seek, ...everyPlain(set)]) {
          expect([...g].length, g).toBeLessThanOrEqual(set.maxLength);
        }
        const named = [
          ...set.alwaysNamed,
          ...set.byHour.flatMap(([, , , n]) => n),
          ...set.byDay.flatMap(([, n]) => n),
        ];
        for (const g of named) expect(g, g).toContain("{name}");
        expect(new Set(set.always).size).toBe(set.always.length);
      }
    });

    it('英文界面挑英文的；没有汉字，标点是半角；没有"你是某地人吗"', () => {
      resetForTests("en");
      const now = at(2, 9);
      const pool = greetingPool("Xuesheng", now);
      expect(pool).toContain("Welcome back, Xuesheng");
      for (const g of [...pool, enGreetings.seek]) {
        expect(g).not.toMatch(/\p{Script=Han}|[，。？！、]/u);
      }
      expect(pickGreeting({ name: "Xuesheng", now, random: () => 0 })).toBe(
        "To strive, to seek, to find",
      );
      // 猜得出地区也不说：那 20% 分给其余的句子
      expect(pickGreeting({ name: "Xuesheng", now, random: () => 0.2, region: "CN" })).toBe(
        pool[0],
      );
    });

    it("先挑好的那句是中文的，换成英文以后作废、现挑一句英文的", () => {
      vi.useFakeTimers();
      try {
        prepareGreeting("雪生", () => undefined);
        resetForTests("en");
        const text = takeGreeting("雪生");
        expect([...greetingPool("雪生", new Date(), enGreetings), enGreetings.seek]).toContain(
          text,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
