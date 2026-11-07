import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../../testing/test-app";
import { isValidDate, missingCalendarYears, peakStatus, WorkdayCalendar } from "./peak-hours";

/** 北京时间的时刻，比如 bj("2026-11-09 09:00")。 */
const bj = (time: string) => new Date(`${time.replace(" ", "T")}:00+08:00`);

const builtIn = new WorkdayCalendar();
const at = (time: string, calendar = builtIn) => peakStatus(bj(time), calendar);

describe("高峰时段", () => {
  it.each([
    // 2026-11-09 是周一
    ["2026-11-09 08:59", false, "2026-11-09 09:00"],
    ["2026-11-09 09:00", true, "2026-11-09 12:00"],
    ["2026-11-09 11:59", true, "2026-11-09 12:00"],
    ["2026-11-09 12:00", false, "2026-11-09 14:00"],
    ["2026-11-09 13:59", false, "2026-11-09 14:00"],
    ["2026-11-09 14:00", true, "2026-11-09 18:00"],
    ["2026-11-09 17:59", true, "2026-11-09 18:00"],
    ["2026-11-09 18:00", false, "2026-11-10 09:00"],
    ["2026-11-09 00:00", false, "2026-11-09 09:00"],
  ])("普通工作日 %s：高峰 %s，下一次切换 %s", (time, peak, next) => {
    const status = at(time);
    expect(status.peak).toBe(peak);
    expect(status.nextSwitchAt).toEqual(bj(next));
    expect(status.today).toMatchObject({ date: "2026-11-09", kind: "workday", name: null });
  });

  it("按北京时间算日子，不按服务器的时区", () => {
    // UTC 11-09 01:30 是北京时间 09:30
    expect(peakStatus(new Date("2026-11-09T01:30:00Z"), builtIn)).toMatchObject({
      peak: true,
      today: { date: "2026-11-09" },
    });
    // UTC 11-08 16:00 已经是北京时间 11-09 零点
    expect(peakStatus(new Date("2026-11-08T16:00:00Z"), builtIn).today.date).toBe("2026-11-09");
  });

  it("周末全天空闲；周五下班后下一次高峰是周一 9 点", () => {
    expect(at("2026-11-14 10:00")).toMatchObject({
      peak: false,
      today: { kind: "weekend", isOffDay: true },
    });
    expect(at("2026-11-13 18:00").nextSwitchAt).toEqual(bj("2026-11-16 09:00"));
  });

  it("法定节假日全天空闲，下一次高峰在假期之后", () => {
    const status = at("2026-10-01 10:00");
    expect(status).toMatchObject({ peak: false, today: { kind: "holiday", name: "国庆节" } });
    expect(status.nextSwitchAt).toEqual(bj("2026-10-08 09:00"));
  });

  it("调休放假的工作日算空闲", () => {
    // 2026-10-06 是周二
    expect(at("2026-10-06 10:00")).toMatchObject({
      peak: false,
      today: { kind: "holiday", name: "国庆节" },
    });
    // 2026-02-23 是周一，春节假期的最后一天
    expect(at("2026-02-23 15:00").peak).toBe(false);
  });

  it("调休上班的周末算高峰", () => {
    // 2026-10-10 是周六
    expect(at("2026-10-10 10:00")).toMatchObject({
      peak: true,
      today: { kind: "makeup_workday", name: "国庆节" },
    });
    // 2026-09-20 是周日；前一天周六下班后，下一次高峰就是它
    expect(at("2026-09-19 10:00").nextSwitchAt).toEqual(bj("2026-09-20 09:00"));
  });

  it("跨年：2026 年最后一个工作日下班后，下一次高峰在 2027 年元旦假期之后", () => {
    expect(at("2026-12-31 18:00").nextSwitchAt).toEqual(bj("2027-01-04 09:00"));
    expect(at("2027-01-01 10:00").today).toMatchObject({ kind: "holiday", name: "元旦" });
    // 2027-01-31 是周日，春节调休上班
    expect(at("2027-01-31 10:00")).toMatchObject({ peak: true, today: { kind: "makeup_workday" } });
  });

  it("没有放假安排的年份只按周一到周五判断，并提示补上", () => {
    // 2028-01-01 是周六，2028-01-03 是周一
    expect(at("2028-01-01 10:00").today).toMatchObject({ kind: "weekend", name: null });
    expect(at("2028-01-03 10:00")).toMatchObject({ peak: true, today: { kind: "workday" } });
    expect(missingCalendarYears(bj("2026-11-07 12:00"), builtIn)).toEqual([]);
    expect(missingCalendarYears(bj("2027-06-01 12:00"), builtIn)).toEqual([2028]);
    expect(missingCalendarYears(bj("2028-03-01 12:00"), builtIn)).toEqual([2028, 2029]);
  });

  it("管理员改的日子盖过内置安排和周末", () => {
    const calendar = new WorkdayCalendar([
      { date: "2026-11-09", isOffDay: true },
      { date: "2026-11-14", isOffDay: false },
      { date: "2026-10-01", isOffDay: false },
      { date: "2028-02-01", isOffDay: true },
    ]);
    expect(at("2026-11-09 10:00", calendar)).toMatchObject({
      peak: false,
      today: { kind: "holiday", name: null },
    });
    expect(at("2026-11-08 18:00", calendar).nextSwitchAt).toEqual(bj("2026-11-10 09:00"));
    expect(at("2026-11-14 10:00", calendar)).toMatchObject({
      peak: true,
      today: { kind: "makeup_workday", name: null },
    });
    expect(at("2026-10-01 10:00", calendar)).toMatchObject({
      peak: true,
      today: { kind: "workday", name: null },
    });
    // 补过 2028 年的日子，就不再提示
    expect(missingCalendarYears(bj("2027-06-01 12:00"), calendar)).toEqual([]);
  });

  it("日期格式", () => {
    expect(isValidDate("2027-02-14")).toBe(true);
    expect(isValidDate("2027-02-30")).toBe(false);
    expect(isValidDate("2027-2-14")).toBe(false);
    expect(isValidDate("明天")).toBe(false);
  });
});

describe("峰谷接口", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ now: bj("2026-10-10 10:00") });
  });
  afterAll(() => t.close());

  it("返回现在是否高峰、下一次切换的时刻和当天是什么日子；管理员改了立刻生效；没登录不行", async () => {
    expect((await t.browser().get("/api/peak-hours")).status).toBe(401);

    const { browser } = await t.signUpWithGitHub("peaker");
    const read = async () => {
      const res = await browser.get("/api/peak-hours");
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await read()).toEqual({
      peak: true,
      nextSwitchAt: bj("2026-10-10 12:00").toISOString(),
      today: { date: "2026-10-10", kind: "makeup_workday", name: "国庆节" },
    });

    await t.setWorkday("2026-10-10", true);
    expect(await read()).toEqual({
      peak: false,
      nextSwitchAt: bj("2026-10-12 09:00").toISOString(),
      // 周六改回休息日，就是普通的周末
      today: { date: "2026-10-10", kind: "weekend", name: null },
    });

    await t.setWorkday("2026-10-10", null);
    expect((await read()).peak).toBe(true);
  });
});
