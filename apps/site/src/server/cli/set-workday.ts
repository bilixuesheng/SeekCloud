// 管理员按天改工作日历：pnpm calendar:set 2027-02-14 workday|off|default
// 管理端的界面以后再做；在那之前用这个命令。

import {
  isValidDate,
  loadWorkdayCalendar,
  missingCalendarYears,
  setWorkdayOverride,
} from "../billing/peak-hours";
import { connectDatabase } from "../db/client";
import { systemClock } from "../ports";

const values = { workday: false, off: true, default: null } as const;
const [date, value] = process.argv.slice(2);
if (!date || !isValidDate(date) || !value || !(value in values)) {
  console.error("用法：pnpm calendar:set <YYYY-MM-DD> <workday|off|default>");
  console.error("workday 设成工作日，off 设成休息日，default 去掉改动、回到内置的放假安排");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("缺少环境变量 DATABASE_URL");
const { db, close } = connectDatabase(databaseUrl);

await setWorkdayOverride({ db, clock: systemClock }, date, values[value as keyof typeof values]);
const calendar = await loadWorkdayCalendar({ db });
const day = calendar.day(date);
console.log(`${date}：${day.isOffDay ? "休息日" : "工作日"}`);
const missing = missingCalendarYears(systemClock.now(), calendar);
if (missing.length > 0) {
  console.log(`${missing.join("、")} 年还没有放假安排，现在只按周一到周五算工作日。`);
}
await close();
