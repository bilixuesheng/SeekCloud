/**
 * 按浏览器的使用习惯猜管理员是哪里人，首页的问候语用（"你是中国人吗，某某"）。
 * IP 能换，看的是使用习惯：浏览器的语言列表（第一个带地区的，比如 zh-CN、en-US、pt-BR）；
 * 只写了语言、没写地区时，几种基本只在一个地方用的语言直接对上（ja → 日本）；中文再看时区。
 * 大陆、香港、澳门都说"中国"；台湾不说这句。
 * 只在浏览器里算，不发给服务器、不存；字体探测、WebRTC 地址这类指纹手段不用。猜不出来就不说这句。
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

/** 只写了 zh 时，按时区分。 */
const CHINESE_TIME_ZONES: Record<string, string> = {
  "Asia/Shanghai": "CN",
  "Asia/Urumqi": "CN",
  "Asia/Chongqing": "CN",
  "Asia/Harbin": "CN",
  "Asia/Hong_Kong": "HK",
  "Asia/Macau": "MO",
  "Asia/Taipei": "TW",
  "Asia/Singapore": "SG",
};

/** 这几个地区不说这句（2026-11-14 用户定的：台湾不出现）。 */
const SKIP = new Set(["TW", "XK", "EH"]);

/** 说成"中国"的地区：大陆、香港、澳门都是中国（2026-11-14 用户定的）。 */
const CHINA = new Set(["CN", "HK", "MO"]);

export function guessRegion(
  languages: readonly string[],
  timeZone: string | undefined,
): string | undefined {
  for (const tag of languages) {
    let locale: Intl.Locale;
    try {
      locale = new Intl.Locale(tag);
    } catch {
      continue;
    }
    const region = locale.region;
    if (region && /^[A-Z]{2}$/.test(region)) return SKIP.has(region) ? undefined : region;
    if (locale.language === "zh") {
      const byZone = timeZone ? CHINESE_TIME_ZONES[timeZone] : undefined;
      if (byZone) return SKIP.has(byZone) ? undefined : byZone;
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
