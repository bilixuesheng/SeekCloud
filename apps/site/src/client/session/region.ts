import { countryOfTimeZone } from "./time-zones";

/**
 * 按浏览器的使用习惯猜管理员是哪里人，首页的问候语用（"你是中国人吗，某某"）。
 * 按优先级取第一个说得出地区的信号（2026-11-14、11-15 用户定的）：
 * 1. 浏览器的语言列表（整个列表，不只是显示语言）：按顺序第一个说得出地区的；英文是通用语言，列表里有别的语言就不看英文，
 *    只有英文时时区优先（不少中国开发者把 en-US 放在第一位）；
 * 2. 时区（Asia/Shanghai → 中国，表在 time-zones.ts）；
 * 3. IP：要一份 IP 地理库或者把 IP 发给第三方查，为一句问候不值得，没做。
 * 大陆、香港、澳门都说"中国"；台湾不说这句。只在浏览器里算，不发给服务器、不存；字体探测、WebRTC 地址这类指纹手段不用。
 */

/** 基本只在一个地方用的语言。 */
const ONE_PLACE_LANGUAGES: Record<string, string> = {
  ja: "JP",
  ko: "KR",
  th: "TH",
  vi: "VN",
  id: "ID",
  tr: "TR",
  pl: "PL",
  uk: "UA",
  he: "IL",
  el: "GR",
  cs: "CZ",
  hu: "HU",
  ro: "RO",
  sv: "SE",
  fi: "FI",
  da: "DK",
  nb: "NO",
  is: "IS",
  fa: "IR",
  bn: "BD",
};

/** 这几个地区不说这句（2026-11-14 用户定的：台湾不出现）。 */
const SKIP = new Set(["TW", "XK", "EH"]);

/** 说成"中国"的地区：大陆、香港、澳门都是中国（2026-11-14 用户定的）。 */
const CHINA = new Set(["CN", "HK", "MO"]);

const locales = (languages: readonly string[]) =>
  languages.flatMap((tag) => {
    try {
      return [new Intl.Locale(tag)];
    } catch {
      return [];
    }
  });

/** 按上面的优先级猜一个地区码；猜到的是不说的地区（台湾）时返回 undefined，不再往下猜。 */
export function guessRegion(
  languages: readonly string[],
  timeZone: string | undefined,
): string | undefined {
  const list = locales(languages);
  const zone = timeZone ? countryOfTimeZone(timeZone) : undefined;
  // 英文是通用语言，很多人（包括不少中国开发者）把它放在列表第一位，不能当成"是哪里人"的强信号：
  // 列表里有别的语言就看别的语言；只有英文时，时区比 en-US 里的 US 更可信。
  const native = list.filter((locale) => locale.language !== "en");
  const english = list.filter((locale) => locale.language === "en");
  const found =
    native.length > 0
      ? (fromLanguages(native, zone) ?? zone)
      : (zone ?? fromLanguages(english, zone));
  return found && !SKIP.has(found) ? found : undefined;
}

/**
 * 从语言列表里猜（整个列表，不只是显示语言）：按顺序，第一个说得出地区的为准。
 * 中文单独看：带地区的看地区；只写了文字的，简体（zh-Hans）是中国，繁体（zh-Hant）再看时区是香港、澳门还是台湾，
 * 不能因为时区在台湾就把用简体的人当成台湾人。
 */
function fromLanguages(list: Intl.Locale[], zone: string | undefined): string | undefined {
  for (const locale of list) {
    if (locale.region && /^[A-Z]{2}$/.test(locale.region)) return locale.region;
    if (locale.language === "zh") {
      if (locale.script === "Hans") return "CN";
      if (locale.script === "Hant")
        return zone === "HK" || zone === "MO" || zone === "TW" ? zone : "TW";
      continue;
    }
    const only = ONE_PLACE_LANGUAGES[locale.language];
    if (only) return only;
  }
  return undefined;
}

/** 地区的中文名（中国、美国……）；浏览器给不出名字时返回 undefined。 */
export function regionName(code: string): string | undefined {
  if (CHINA.has(code)) return "中国";
  if (SKIP.has(code)) return undefined;
  try {
    const name = new Intl.DisplayNames(["zh-CN"], { type: "region", style: "short" }).of(code);
    return name && name !== code ? name : undefined;
  } catch {
    return undefined;
  }
}

/** 这台浏览器的地区名，问候语用。 */
export function localRegionName(): string | undefined {
  try {
    const code = guessRegion(
      navigator.languages ?? [navigator.language],
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    return code ? regionName(code) : undefined;
  } catch {
    return undefined;
  }
}
