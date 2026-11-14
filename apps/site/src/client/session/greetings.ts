/**
 * 新会话页的问候语：每次打开随机挑一句。
 * 有的看时间（按浏览器的当地时间）、看星期几，只在对应的时候出现；设置过昵称时，一部分带上昵称（照 Claude 的"Good afternoon, 某某"）。
 * 可以有文采，不能俏皮（docs/brand/README.md 的界面文案规范）。
 */

/** 什么时候都可以出现的。古诗文都是原句，出处写在后面。 */
const ALWAYS = [
  "今日有何计划？",
  "从何处着手？",
  "请描述你的任务",
  "欢迎回来",
  "路漫漫其修远兮", // 屈原《离骚》
  "吾将上下而求索", // 同上
  "千里之行，始于足下", // 《老子》
  "不积跬步，无以至千里", // 《荀子·劝学》
  "工欲善其事，必先利其器", // 《论语·卫灵公》
  "博观而约取，厚积而薄发", // 苏轼《稼说送张琥》
  "纸上得来终觉浅，绝知此事要躬行", // 陆游《冬夜读书示子聿》
  "山重水复疑无路，柳暗花明又一村", // 陆游《游山西村》
  "问渠那得清如许？为有源头活水来", // 朱熹《观书有感》
  "不畏浮云遮望眼", // 王安石《登飞来峰》
  "行到水穷处，坐看云起时", // 王维《终南别业》
  "白云生处有人家", // 杜牧《山行》
  "苟日新，日日新，又日新", // 《礼记·大学》
  "他山之石，可以攻玉", // 《诗经·小雅·鹤鸣》
  "长风破浪会有时", // 李白《行路难》
  "欲穷千里目，更上一层楼", // 王之涣《登鹳雀楼》
  "会当凌绝顶，一览众山小", // 杜甫《望岳》
  "吾日三省吾身", // 《论语·学而》
  "业精于勤", // 韩愈《进学解》
  "天行健，君子以自强不息", // 《周易》
  // 求索、探究的
  "路漫漫其修远兮，吾将上下而求索", // 屈原《离骚》
  "探赜索隐，钩深致远", // 《周易·系辞上》
  "众里寻他千百度", // 辛弃疾《青玉案·元夕》
  "千淘万漉虽辛苦，吹尽狂沙始到金", // 刘禹锡《浪淘沙》
  "不识庐山真面目，只缘身在此山中", // 苏轼《题西林壁》
  "穷则变，变则通，通则久", // 《周易·系辞下》
  "博学之，审问之，慎思之，明辨之，笃行之", // 《礼记·中庸》
  "致知在格物", // 《礼记·大学》
  "温故而知新", // 《论语·为政》
  "锲而不舍，金石可镂", // 《荀子·劝学》
  "九层之台，起于累土", // 《老子》
  "大鹏一日同风起，扶摇直上九万里", // 李白《上李邕》
  "惟精惟一", // 《尚书·大禹谟》
  "逝者如斯夫，不舍昼夜", // 《论语·子罕》
];

/** 带昵称的，什么时候都可以出现。 */
const ALWAYS_NAMED = [
  "欢迎回来，{name}",
  "你好，{name}",
  "{name}，近来可好？",
  "{name}，今日有何计划？",
  "{name}，继续上次的工作？",
  "{name}，有何新进展？",
];

/** 一天里的几个时段：[开始的小时, 结束的小时（不含）, 不带昵称的, 带昵称的]。 */
const BY_HOUR: Array<[number, number, string[], string[]]> = [
  [5, 11, ["早上好", "新的一天，从何开始？", "一日之计在于晨"], ["早上好，{name}"]],
  [11, 14, ["中午好"], ["中午好，{name}"]],
  [14, 18, ["下午好"], ["下午好，{name}"]],
  [18, 23, ["晚上好"], ["晚上好，{name}", "{name}，今天过得如何？"]],
  // 杜甫《旅夜书怀》
  [23, 29, ["夜深了，注意休息", "夜深，仍在求索", "星垂平野阔，月涌大江流"], ["夜深了，{name}"]],
];

/** 星期几（0 是周日）：[不带昵称的, 带昵称的]，只在当天出现。 */
const BY_DAY: Array<[string[], string[]]> = [
  [
    ["周末愉快", "偷得浮生半日闲"],
    ["周日愉快，{name}", "周末愉快，{name}"],
  ],
  [[], ["周一愉快，{name}"]],
  [[], ["周二愉快，{name}"]],
  [[], ["周三愉快，{name}"]],
  [[], ["周四愉快，{name}"]],
  [[], ["周五愉快，{name}"]],
  // 李涉《题鹤林寺僧舍》
  [
    ["周末愉快", "偷得浮生半日闲"],
    ["周六愉快，{name}", "周末愉快，{name}"],
  ],
];

/**
 * 此刻能用的问候语。带昵称的排在后面，权重是两倍（Claude 的问候常常带名字）。
 * name 为空时只有不带昵称的。
 */
export function greetingPool(name: string | null | undefined, now: Date): string[] {
  const hour = now.getHours();
  const plain = [...ALWAYS];
  const named = [...ALWAYS_NAMED];
  for (const [from, to, p, n] of BY_HOUR) {
    // 夜里的时段跨过零点：23 点到第二天 5 点
    if ((hour >= from && hour < to) || (to > 24 && hour < to - 24)) {
      plain.push(...p);
      named.push(...n);
    }
  }
  const [dayPlain, dayNamed] = BY_DAY[now.getDay()] ?? [[], []];
  plain.push(...dayPlain);
  named.push(...dayNamed);
  const who = name?.trim();
  if (!who) return plain;
  const filled = named.map((g) => g.replace("{name}", who));
  return [...plain, ...filled, ...filled];
}

export function pickGreeting({
  name,
  now = new Date(),
  random = Math.random,
}: {
  name?: string | null;
  now?: Date;
  random?: () => number;
} = {}): string {
  const pool = greetingPool(name, now);
  return pool[Math.floor(random() * pool.length)] ?? "今日有何计划？";
}

/** 页面一打开就先挑好的那一句，首页第一次显示时用它（它的字体已经在拉了）。 */
let early: { name: string | null; text: string } | undefined;

/**
 * 页面刚打开时先挑一句，并开始拉它要用的字体：等登录状态回来、首页画出来时字体多半已经到了，问候语不用干等。
 * name 是上次记下的昵称（这时候还没问过服务器）。
 */
export function prepareGreeting(name: string | null, preload: (text: string) => void): void {
  early = { name, text: pickGreeting({ name }) };
  preload(early.text);
}

/** 首页要显示的问候语：昵称和先挑的那句对得上就用它（只用一次），不然现挑一句。 */
export function takeGreeting(name: string | null): string {
  const picked = early;
  early = undefined;
  if (picked && picked.name === (name?.trim() || null)) return picked.text;
  return pickGreeting({ name });
}
