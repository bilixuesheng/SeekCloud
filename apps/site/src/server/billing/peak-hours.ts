import { eq } from "drizzle-orm";
import type { AppDeps } from "../app";
import { workdayOverrides } from "../db/schema";
import { HOLIDAYS } from "./holidays";

/**
 * 高峰时段：北京时间工作日 9:00–12:00、14:00–18:00（照 DeepSeek 的峰谷价）。
 * 工作日按国务院的工作日历：法定节假日和调休放假日全天空闲，调休上班日照常有高峰。
 * 模型网关计费、用量圆环和弹层都只用这里的判断。
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// 北京时间没有夏令时，固定 UTC+8。
const BEIJING = 8 * 60 * MINUTE;
const PEAK_WINDOWS: Array<[start: number, end: number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

/** workday 普通工作日；weekend 周末；holiday 节假日（含调休放假）；makeup_workday 调休上班日。 */
export type DayKind = "workday" | "weekend" | "holiday" | "makeup_workday";

export interface DayInfo {
  /** 北京时间的日期，YYYY-MM-DD。 */
  date: string;
  kind: DayKind;
  /** 节假日或调休上班属于哪个节日；普通日子和管理员改的日子没有。 */
  name: string | null;
  isOffDay: boolean;
}

export interface PeakStatus {
  peak: boolean;
  /** 下一次在高峰和空闲之间切换的时刻。 */
  nextSwitchAt: Date;
  today: DayInfo;
}

interface CalendarEntry {
  isOffDay: boolean;
  name: string | null;
}

const builtIn = new Map<string, CalendarEntry>();
for (const arrangements of Object.values(HOLIDAYS)) {
  for (const { name, off, work = [] } of arrangements) {
    for (let t = Date.parse(off[0]); t <= Date.parse(off[1]); t += DAY) {
      builtIn.set(isoDate(t), { isOffDay: true, name });
    }
    for (const date of work) builtIn.set(date, { isOffDay: false, name });
  }
}

/** 内置的放假安排加上管理员按天改的（改的优先）。 */
export class WorkdayCalendar {
  readonly #overrides: Map<string, boolean>;

  constructor(overrides: Iterable<{ date: string; isOffDay: boolean }> = []) {
    this.#overrides = new Map([...overrides].map((o) => [o.date, o.isOffDay]));
  }

  day(date: string): DayInfo {
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    const override = this.#overrides.get(date);
    const entry: CalendarEntry =
      override !== undefined
        ? { isOffDay: override, name: null }
        : (builtIn.get(date) ?? { isOffDay: weekend, name: null });
    const kind: DayKind = entry.isOffDay
      ? weekend && entry.name === null
        ? "weekend"
        : "holiday"
      : weekend
        ? "makeup_workday"
        : "workday";
    return { date, kind, ...entry };
  }

  /** 这一年有没有放假安排：内置了，或者管理员补过其中的日子。 */
  hasYear(year: number): boolean {
    return year in HOLIDAYS || [...this.#overrides.keys()].some((d) => d.startsWith(`${year}-`));
  }
}

export function peakStatus(at: Date, calendar: WorkdayCalendar): PeakStatus {
  const local = at.getTime() + BEIJING;
  const todayStart = Math.floor(local / DAY) * DAY;
  const today = calendar.day(isoDate(todayStart));
  const minute = (local - todayStart) / MINUTE;
  const peak = !today.isOffDay && PEAK_WINDOWS.some(([s, e]) => minute >= s && minute < e);
  return { peak, nextSwitchAt: new Date(nextSwitch(local, todayStart, calendar) - BEIJING), today };
}

/** 两段高峰之间都有空闲，所以从现在往后的第一个起点或终点就是下一次切换。 */
function nextSwitch(local: number, todayStart: number, calendar: WorkdayCalendar): number {
  // 两年里一天工作日都没有，只可能是管理员把日历改坏了。
  for (let dayStart = todayStart; dayStart < todayStart + 2 * 366 * DAY; dayStart += DAY) {
    if (calendar.day(isoDate(dayStart)).isOffDay) continue;
    for (const [s, e] of PEAK_WINDOWS) {
      for (const minute of [s, e]) {
        const t = dayStart + minute * MINUTE;
        if (t > local) return t;
      }
    }
  }
  throw new Error("两年内没有工作日，工作日历可能设错了");
}

/** 今年和下一年里还没有放假安排的年份，管理端据此提示管理员补上。 */
export function missingCalendarYears(at: Date, calendar: WorkdayCalendar): number[] {
  const year = new Date(at.getTime() + BEIJING).getUTCFullYear();
  return [year, year + 1].filter((y) => !calendar.hasYear(y));
}

export async function loadWorkdayCalendar(deps: Pick<AppDeps, "db">): Promise<WorkdayCalendar> {
  return new WorkdayCalendar(await deps.db.select().from(workdayOverrides));
}

/** 模型网关计费时调用：这个时刻算不算高峰。 */
export async function isPeakAt(deps: Pick<AppDeps, "db">, at: Date): Promise<boolean> {
  return peakStatus(at, await loadWorkdayCalendar(deps)).peak;
}

/** 管理员把某一天设成工作日或休息日；null 表示去掉改动，回到内置的安排。 */
export async function setWorkdayOverride(
  deps: Pick<AppDeps, "db" | "clock">,
  date: string,
  isOffDay: boolean | null,
): Promise<void> {
  if (!isValidDate(date)) throw new Error(`日期格式不对：${date}`);
  if (isOffDay === null) {
    await deps.db.delete(workdayOverrides).where(eq(workdayOverrides.date, date));
    return;
  }
  const updatedAt = deps.clock.now();
  await deps.db
    .insert(workdayOverrides)
    .values({ date, isOffDay, updatedAt })
    .onConflictDoUpdate({ target: workdayOverrides.date, set: { isOffDay, updatedAt } });
}

export function isValidDate(date: string): boolean {
  const ms = Date.parse(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(ms) && isoDate(ms) === date;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
