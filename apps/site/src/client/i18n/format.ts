import { currentLocale, type Locale, t } from "./index";

/**
 * 日期、时间、数字按当前语言写（#135）：用浏览器自带的 Intl。"5 分钟前"这类相对时间的说法在文案目录里
 * （中文要求数字和汉字之间有空格，Intl 的"5分钟前"不合规范；英文要分单复数）。
 */

const cache = new Map<string, Intl.DateTimeFormat>();
function format(locale: Locale, options: Intl.DateTimeFormatOptions, at: Date): string {
  const id = `${locale}|${JSON.stringify(options)}`;
  let f = cache.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    cache.set(id, f);
  }
  return f.format(at);
}

/** 月份：中文写"11月"（数字月份在中文里会变成 11/1），英文写缩写"Nov"。 */
const month = (locale: Locale) => (locale === "zh-CN" ? "long" : "short");
const CLOCK = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 24 * 60 * 60 * 1000;

/**
 * 消息下面的时间，说人话：刚刚、5 分钟前、今天 14:02、昨天 14:02、11月1日 14:02，不是今年的写全年份。
 * 用本地时间。
 */
export function relativeTime(at: Date, now: Date): string {
  const locale = currentLocale();
  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000);
  // 本机时钟比服务器慢一点时也算"刚刚"，不显示负数。
  if (seconds < 60) return t("time.justNow");
  if (seconds < 3600) return t("time.minutesAgo", { count: Math.floor(seconds / 60) });
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  const time = format(locale, CLOCK, at);
  if (days === 0) return t("time.today", { time });
  if (days === 1) return t("time.yesterday", { time });
  if (at.getFullYear() === now.getFullYear()) {
    return format(locale, { month: month(locale), day: "numeric", ...CLOCK }, at);
  }
  return format(locale, { year: "numeric", month: month(locale), day: "numeric" }, at);
}

/** 设置页上的时间：11月2日 20:02。 */
export function shortDateTime(at: Date): string {
  const locale = currentLocale();
  return format(locale, { month: month(locale), day: "numeric", ...CLOCK }, at);
}

/** 指上去看到的完整时间。 */
export function fullTime(at: Date): string {
  const locale = currentLocale();
  return format(
    locale,
    { year: "numeric", month: month(locale), day: "numeric", ...CLOCK, second: "2-digit" },
    at,
  );
}

/**
 * 会话列表里的时间："刚刚"、"5 分钟前"……更早的写日期。中文界面的日期按北京时间（以前就是这样），
 * 英文界面按本地时间。
 */
export function listTime(iso: string, now = Date.now()): string {
  const locale = currentLocale();
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { count: minutes });
  if (minutes < 24 * 60) return t("time.hoursAgo", { count: Math.floor(minutes / 60) });
  if (minutes < 7 * 24 * 60) return t("time.daysAgo", { count: Math.floor(minutes / (24 * 60)) });
  return format(
    locale,
    locale === "zh-CN"
      ? { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }
      : { month: "short", day: "numeric" },
    new Date(iso),
  );
}

/** 等了多久（首页"有会话在等你输入"的列表）："刚刚""等了 5 分钟""等了 2 小时"……一周以前的写日期。 */
export function waitedTime(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.waitedMinutes", { count: minutes });
  if (minutes < 24 * 60) return t("time.waitedHours", { count: Math.floor(minutes / 60) });
  if (minutes < 7 * 24 * 60) {
    return t("time.waitedDays", { count: Math.floor(minutes / (24 * 60)) });
  }
  return listTime(iso, now);
}

const lists = new Map<Locale, Intl.ListFormat>();
const englishList = (locale: Locale) => {
  let f = lists.get(locale);
  if (!f) {
    f = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
    lists.set(locale, f);
  }
  return f;
};

/**
 * 几个分句连成一句（"读取了 3 个文件，运行了 2 条命令"）：中文用逗号；英文 "read 3 files, edited 1 file,
 * and ran 2 commands"，句首大写。每个分句是文案目录里的整句模板，这里只管怎么连。
 */
export function joinClauses(clauses: string[]): string {
  const locale = currentLocale();
  if (locale === "zh-CN") return clauses.join("，");
  const text = englishList(locale).format(clauses);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 几个名字（仓库名这类）连起来：中文用顿号，英文 "a, b, and c"。 */
export function joinNames(names: string[]): string {
  const locale = currentLocale();
  return locale === "zh-CN" ? names.join("、") : englishList(locale).format(names);
}

/** 几个可以互相替代的名字（环境变量这类，有一个就行）：中文用顿号，英文 "a, b, or c"。 */
export function joinAlternatives(names: string[]): string {
  const locale = currentLocale();
  if (locale === "zh-CN") return names.join("、");
  return new Intl.ListFormat(locale, { style: "long", type: "disjunction" }).format(names);
}

/**
 * 几分钟拆成数字和单位（分段选择里数字在上、单位在下）：单位的说法和单复数按语言，用 Intl 的单位格式
 * （英文 minute、minutes；中文"分钟"）。
 */
export function minutesParts(minutes: number): { value: string; unit: string } {
  const parts = new Intl.NumberFormat(currentLocale(), {
    style: "unit",
    unit: "minute",
    unitDisplay: "long",
  }).formatToParts(minutes);
  const value = parts
    .filter(
      (p) =>
        p.type === "integer" || p.type === "group" || p.type === "decimal" || p.type === "fraction",
    )
    .map((p) => p.value)
    .join("");
  const unit = parts
    .filter((p) => p.type === "unit")
    .map((p) => p.value)
    .join("")
    .trim();
  return { value, unit };
}

/** 数字：千分位按语言（131,072）。 */
export const formatNumber = (n: number): string => n.toLocaleString(currentLocale());
