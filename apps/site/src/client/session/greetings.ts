/**
 * 新会话页的问候语：每次打开随机挑一句。
 * 有的看时间（按浏览器的当地时间）、看星期几，只在对应的时候出现；设置过昵称时，一部分带上昵称（照 Claude 的"Good afternoon, 某某"）。
 * 可以有文采，不能俏皮（docs/brand/README.md 的界面文案规范）。
 */

/**
 * 句子不超过 14 个字（2026-11-16 用户定的）：手机上问候语一行大约放 14 个字，再长就折成两行。
 * 原句太长的拆成上下两句，各自单独出现。
 */

/** 单独调高的两句，各占 BOOST 的机会（2026-11-16 用户定的）。 */
const SEEK = "吾将上下而求索"; // 屈原《离骚》
const BOOST = 0.2;

/** 什么时候都可以出现的。古诗文都是原句，出处写在后面。 */
const ALWAYS = [
  "今日有何计划？",
  "从何处着手？",
  "请描述你的任务",
  "欢迎回来",
  // 求索、探究
  "路漫漫其修远兮", // 屈原《离骚》
  "探赜索隐，钩深致远", // 《周易·系辞上》
  "众里寻他千百度", // 辛弃疾《青玉案·元夕》
  "致知在格物", // 《礼记·大学》
  "惟精惟一", // 《尚书·大禹谟》
  // 勤学、积累
  "千里之行，始于足下", // 《老子》
  "不积跬步，无以至千里", // 《荀子·劝学》
  "工欲善其事，必先利其器", // 《论语·卫灵公》
  "博观而约取，厚积而薄发", // 苏轼《稼说送张琥》
  "纸上得来终觉浅", // 陆游《冬夜读书示子聿》
  "绝知此事要躬行", // 同上
  "苟日新，日日新，又日新", // 《礼记·大学》
  "吾日三省吾身", // 《论语·学而》
  "业精于勤", // 韩愈《进学解》
  "温故而知新", // 《论语·为政》
  "锲而不舍，金石可镂", // 《荀子·劝学》
  "九层之台，起于累土", // 《老子》
  // 山水、豪情
  "山重水复疑无路", // 陆游《游山西村》
  "柳暗花明又一村", // 同上
  "问渠那得清如许", // 朱熹《观书有感》
  "为有源头活水来", // 同上
  "不畏浮云遮望眼", // 王安石《登飞来峰》
  "行到水穷处，坐看云起时", // 王维《终南别业》
  "白云生处有人家", // 杜牧《山行》
  "他山之石，可以攻玉", // 《诗经·小雅·鹤鸣》
  "长风破浪会有时", // 李白《行路难》
  "欲穷千里目，更上一层楼", // 王之涣《登鹳雀楼》
  "会当凌绝顶，一览众山小", // 杜甫《望岳》
  "天行健，君子以自强不息", // 《周易》
  "千淘万漉虽辛苦", // 刘禹锡《浪淘沙》
  "吹尽狂沙始到金", // 同上
  "不识庐山真面目", // 苏轼《题西林壁》
  "只缘身在此山中", // 同上
  "穷则变，变则通，通则久", // 《周易·系辞下》
  "大鹏一日同风起", // 李白《上李邕》
  "扶摇直上九万里", // 同上
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
  // 陶渊明《归园田居》
  [5, 11, ["新的一天，从何开始？", "一日之计在于晨", "晨兴理荒秽"], []],
  // 王勃《滕王阁序》、张九龄《望月怀远》、李白《月下独酌》
  [
    18,
    23,
    ["落霞与孤鹜齐飞", "海上生明月，天涯共此时", "举杯邀明月"],
    ["{name}，今天过得如何？", "{name}，月下论道？"],
  ],
  // 杜甫《旅夜书怀》、王维《山居秋暝》
  [
    23,
    29,
    ["夜深了，注意休息", "夜深，仍在求索", "星垂平野阔，月涌大江流", "明月松间照，清泉石上流"],
    ["夜深了，{name}", "{name}，月下论道？"],
  ],
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
 * 此刻除了单独调高的两句以外能用的问候语，每句机会一样。name 为空时只有不带昵称的。
 * "吾将上下而求索"和"你是某地人吗"不在里面，由 pickGreeting 按固定的机会挑。
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
  return [...plain, ...named.map((g) => g.replace("{name}", who))];
}

/**
 * 挑一句：BOOST 的机会是"吾将上下而求索"；设了昵称又猜得出地区时，再有 BOOST 的机会是"你是某地人吗"
 * （猜不出来时这份机会分给其余的句子）；剩下的在 greetingPool 里平均分。
 */
export function pickGreeting({
  name,
  now = new Date(),
  random = Math.random,
  region,
}: {
  name?: string | null;
  now?: Date;
  random?: () => number;
  /** 按浏览器的语言猜出的地区名（region.ts），猜不出来时没有"你是某地人吗"这句。 */
  region?: string;
} = {}): string {
  const r = random();
  if (r < BOOST) return SEEK;
  const who = name?.trim();
  const regional = who && region ? `你是${region}人吗，${who}` : undefined;
  if (regional && r < 2 * BOOST) return regional;
  const used = regional ? 2 * BOOST : BOOST;
  const pool = greetingPool(name, now);
  const index = Math.floor(((r - used) / (1 - used)) * pool.length);
  return pool[Math.min(index, pool.length - 1)] ?? SEEK;
}

/** 先挑好的下一句，首页显示时用它（它的字体已经在拉了）。 */
let early: { name: string | null; text: string } | undefined;
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
  early = { name, text: pickGreeting({ name, region }) };
  preload(early.text);
}

/** 拉下一句的字体要等多久：别和这一次显示要拉的字体抢。 */
const NEXT_DELAY_MS = 1500;

/**
 * 首页要显示的问候语：昵称和先挑的那句对得上就用它（只用一次），不然现挑一句。
 * 用掉以后在后台把下一次的那句先挑好、先拉字体：重进首页时换的新句子字体已经在了，
 * 不会先用系统字体（安卓上会粗一档）显示、再跳成思源宋体。
 */
export function takeGreeting(name: string | null, region?: string): string {
  const who = name?.trim() || null;
  const picked = early;
  early = undefined;
  const text = picked && picked.name === who ? picked.text : pickGreeting({ name, region });
  if (preloader) {
    const preload = preloader;
    let next = pickGreeting({ name, region });
    // 尽量不和这一次重样
    for (let i = 0; i < 3 && next === text; i++) next = pickGreeting({ name, region });
    early = { name: who, text: next };
    setTimeout(() => preload(next), NEXT_DELAY_MS);
  }
  return text;
}
