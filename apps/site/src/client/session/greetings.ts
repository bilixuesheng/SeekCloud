import { currentLocale, type Locale } from "../i18n";
import { enGreetings } from "../i18n/greetings-en";
import { zhGreetings } from "../i18n/greetings-zh";

/**
 * 新会话页的问候语：每次打开随机挑一句。
 * 有的看时间（按浏览器的当地时间）、看星期几，只在对应的时候出现；设置过昵称时，一部分带上昵称（照 Claude 的"Good afternoon, 某某"）。
 * 句子按界面语言各写一套（i18n/greetings-zh.ts、greetings-en.ts，#136：英文另写，不直译）。
 */

/** 一种语言的问候语。 */
export interface GreetingSet {
  /** 不带昵称的句子最多几个字（手机上一行放得下的），测试守着。 */
  maxLength: number;
  /** 单独调高的一句（中文是"吾将上下而求索"）。 */
  seek: string;
  /** 什么时候都可以出现的。 */
  always: string[];
  /** 带昵称的（{name}），什么时候都可以出现。 */
  alwaysNamed: string[];
  /** 一天里的几个时段：[开始的小时, 结束的小时（不含，跨零点的写到 24 以上）, 不带昵称的, 带昵称的]。 */
  byHour: Array<[number, number, string[], string[]]>;
  /** 星期几（0 是周日）：[不带昵称的, 带昵称的]，只在当天出现。 */
  byDay: Array<[string[], string[]]>;
  /** "你是某地人吗，某某"：按地区码写一句，写不出来时返回 undefined。只有中文有。 */
  regional?: (region: string, name: string) => string | undefined;
}

const SETS: Record<Locale, GreetingSet> = { "zh-CN": zhGreetings, en: enGreetings };

/** 当前界面语言的那一套。 */
export const greetingSet = (locale: Locale = currentLocale()): GreetingSet => SETS[locale];

/** 单独调高的两句（seek 和"你是某地人吗"），各占 BOOST 的机会（2026-11-16 用户定的）。 */
const BOOST = 0.2;

/**
 * 此刻除了单独调高的两句以外能用的问候语，每句机会一样。name 为空时只有不带昵称的。
 * seek 和"你是某地人吗"不在里面，由 pickGreeting 按固定的机会挑。
 */
export function greetingPool(
  name: string | null | undefined,
  now: Date,
  set: GreetingSet = greetingSet(),
): string[] {
  const hour = now.getHours();
  const plain = [...set.always];
  const named = [...set.alwaysNamed];
  for (const [from, to, p, n] of set.byHour) {
    // 夜里的时段跨过零点：23 点到第二天 5 点
    if ((hour >= from && hour < to) || (to > 24 && hour < to - 24)) {
      plain.push(...p);
      named.push(...n);
    }
  }
  const [dayPlain, dayNamed] = set.byDay[now.getDay()] ?? [[], []];
  plain.push(...dayPlain);
  named.push(...dayNamed);
  const who = name?.trim();
  if (!who) return plain;
  return [...plain, ...named.map((g) => g.replace("{name}", who))];
}

/**
 * 挑一句：BOOST 的机会是 seek（"吾将上下而求索"）；设了昵称、这种语言有"你是某地人吗"、又猜得出地区时，
 * 再有 BOOST 的机会是这句（不然这份机会分给其余的句子）；剩下的在 greetingPool 里平均分。
 */
export function pickGreeting({
  name,
  now = new Date(),
  random = Math.random,
  region,
  set = greetingSet(),
}: {
  name?: string | null;
  now?: Date;
  random?: () => number;
  /** 按浏览器的语言猜出的地区码（region.ts），猜不出来时没有"你是某地人吗"这句。 */
  region?: string;
  set?: GreetingSet;
} = {}): string {
  const r = random();
  if (r < BOOST) return set.seek;
  const who = name?.trim();
  const regional = who && region ? set.regional?.(region, who) : undefined;
  if (regional && r < 2 * BOOST) return regional;
  const used = regional ? 2 * BOOST : BOOST;
  const pool = greetingPool(name, now, set);
  const index = Math.floor(((r - used) / (1 - used)) * pool.length);
  return pool[Math.min(index, pool.length - 1)] ?? set.seek;
}

/** 先挑好的下一句，首页显示时用它（它的字体已经在拉了）。记着是哪种语言挑的：换了语言就作废。 */
let early: { name: string | null; locale: Locale; text: string } | undefined;
/** 拉字体的函数，prepareGreeting 时记下，之后每次都用它给下一句先拉字体。 */
let preloader: ((text: string) => void) | undefined;

/**
 * 页面刚打开时先挑一句，并开始拉它要用的字体：等登录状态回来、首页画出来时字体多半已经到了，问候语不用干等。
 * name 是上次记下的昵称（这时候还没问过服务器）。
 */
export function prepareGreeting(
  name: string | null,
  preload: (text: string) => void,
  region?: string,
): void {
  preloader = preload;
  early = { name, locale: currentLocale(), text: pickGreeting({ name, region }) };
  preload(early.text);
}

/** 拉下一句的字体要等多久：别和这一次显示要拉的字体抢。 */
const NEXT_DELAY_MS = 1500;

/**
 * 首页要显示的问候语：昵称、语言和先挑的那句对得上就用它（只用一次），不然现挑一句。
 * 用掉以后在后台把下一次的那句先挑好、先拉字体：重进首页时换的新句子字体已经在了，
 * 不会先用系统字体（安卓上会粗一档）显示、再跳成思源宋体。
 */
export function takeGreeting(name: string | null, region?: string): string {
  const who = name?.trim() || null;
  const picked = early;
  early = undefined;
  const locale = currentLocale();
  const text =
    picked && picked.name === who && picked.locale === locale
      ? picked.text
      : pickGreeting({ name, region });
  if (preloader) {
    const preload = preloader;
    let next = pickGreeting({ name, region });
    // 尽量不和这一次重样
    for (let i = 0; i < 3 && next === text; i++) next = pickGreeting({ name, region });
    early = { name: who, locale, text: next };
    setTimeout(() => preload(next), NEXT_DELAY_MS);
  }
  return text;
}
