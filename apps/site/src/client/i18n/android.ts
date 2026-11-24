import { appEn } from "./app-en";
import { appZh } from "./app-zh";
import type { Catalog, Locale, Message } from "./catalog";
import { en } from "./en";
import { zh } from "./zh";

/**
 * 从文案目录生成安卓 App 的 strings.xml（#204）：App 的文案写在 app-zh.ts、app-en.ts；品牌名和 [SHARED] 那几组
 * （接口的报错、会话的状态这些）用网页目录里的，两边说法一样。
 * 生成的文件是 apps/android/app/src/main/res/values/strings.xml、values-zh/strings.xml 和报错码对应文案的表
 * （ANDROID_ERRORS_FILE），进仓库；主站的测试（android.test.ts）核对它们是最新的。
 *
 * 转换的规矩：
 * - {brand} 换成这种语言的品牌名；别的 {名字} 换成 %1$s、%2$s……（{count} 是 %n$d），
 *   序号按中文那一份里第一次出现的顺序，两种语言一样，App 里按这个顺序传参数；
 * - 有一种语言分单复数（{ one, other }）就两种都写成 <plurals>（中文只有 other）；
 * - 照安卓资源的规矩转义引号、反斜杠、开头的 @ 和 ?；带参数的文案里的 % 写成 %%。
 */

export type AppKey = keyof typeof appZh;
/** App 的一种语言的目录：键和中文那份完全一样。 */
export type AppCatalog = { readonly [K in AppKey]: Message };

/**
 * 网页目录里 App 也用的几组，两边说法一样：接口的报错、会话的状态、侧栏和会话列表。
 * 键改成安卓的资源名：点换成下划线，驼峰换成下划线（error.rate_limited → error_rate_limited，
 * sessionList.empty → session_list_empty，status.awaitingInput → status_awaiting_input）。
 */
const SHARED = ["error.", "status.", "sidebar.", "sessionList."];

const snake = (key: string) =>
  key
    .replace(/\./g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
const RESERVED = SHARED.map((prefix) => snake(prefix));

function resources(app: AppCatalog, web: Catalog): Record<string, Message> {
  const out: Record<string, Message> = {};
  for (const [key, message] of Object.entries(app)) {
    const reserved = RESERVED.find((prefix) => key.startsWith(prefix));
    if (reserved) throw new Error(`${key}: ${reserved} is reserved for the web catalog`);
    out[key] = message;
  }
  for (const [key, message] of Object.entries(web)) {
    if (SHARED.some((prefix) => key.startsWith(prefix))) out[snake(key)] = message;
  }
  return out;
}

/** 默认的资源（values）用英文：系统语言 App 不支持时用它，和网页一样。values-zh 包括繁体地区。 */
export const ANDROID_LOCALES: {
  locale: Locale;
  dir: string;
  messages: Record<string, Message>;
  brand: string;
}[] = [
  {
    locale: "en",
    dir: "values",
    messages: resources(appEn, en),
    brand: en["brand.name"] as string,
  },
  {
    locale: "zh-CN",
    dir: "values-zh",
    messages: resources(appZh, zh),
    brand: zh["brand.name"] as string,
  },
];

/** 基准：中文那一份。 */
const BASE = resources(appZh, zh);

const KEY = /^[a-z][a-z0-9_]*$/;
const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

const texts = (message: Message): string[] =>
  typeof message === "string" ? [message] : Object.values(message);

/** 一条文案里的插值（不算 {brand}），按第一次出现的顺序。 */
function names(message: Message): string[] {
  const found: string[] = [];
  for (const text of texts(message)) {
    for (const [, name] of text.matchAll(PLACEHOLDER)) {
      if (name && name !== "brand" && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

function escapeText(text: string, formatted: boolean): string {
  const s = text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return formatted ? s.replace(/%/g, "%%") : s;
}

/** 一段文案转成安卓资源里的写法。[order] 是插值的序号表。 */
export function androidText(text: string, brand: string, order: string[], key = "?"): string {
  // 安卓构建时会把前后的空白和连续的空白压掉：文案里不要有
  if (/^\s|\s$|\s\s/.test(text)) throw new Error(`${key}: leading, trailing or repeated spaces`);
  const formatted = order.length > 0;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    out += escapeText(text.slice(last, match.index), formatted);
    const name = match[1] as string;
    if (name === "brand") out += escapeText(brand, formatted);
    else {
      const n = order.indexOf(name);
      if (n < 0) throw new Error(`${key}: {${name}} is not in the Chinese catalog`);
      out += `%${n + 1}$${name === "count" ? "d" : "s"}`;
    }
    last = match.index + match[0].length;
  }
  out += escapeText(text.slice(last), formatted);
  return /^[@?]/.test(out) ? `\\${out}` : out;
}

// 生成的文件开头的说明（XML 的注释里不能有两个连着的减号，所以不直接写命令）
const GENERATED =
  "由 apps/site/src/client/i18n/android.ts 从文案目录生成，不要手改；重新生成的命令是 apps/site/package.json 里的 android:strings"; // 不是界面文案

/** 网页目录共用来的整组文案，App 不一定每条都用：lint 不报"没用到"。App 自己的文案照常检查。 */
const ignore = (key: string) =>
  RESERVED.some((prefix) => key.startsWith(prefix)) ? ' tools:ignore="UnusedResources"' : "";

/** 一种语言的 strings.xml 的内容。 */
export function androidStrings(locale: Locale): string {
  const target = ANDROID_LOCALES.find((l) => l.locale === locale);
  if (!target) throw new Error(`no Android resources for ${locale}`);
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<!-- ${GENERATED} -->`,
    '<resources xmlns:tools="http://schemas.android.com/tools">',
  ];
  for (const [key, base] of Object.entries(BASE)) {
    if (!KEY.test(key)) throw new Error(`${key}: not a valid Android resource name`);
    const message = target.messages[key];
    if (message === undefined) throw new Error(`${key}: missing in ${locale}`);
    const order = names(base);
    const own = names(message);
    if (own.length !== order.length || own.some((n) => !order.includes(n))) {
      throw new Error(`${key}: placeholders differ between languages`);
    }
    const text = (t: string) => androidText(t, target.brand, order, key);
    if (ANDROID_LOCALES.every((l) => typeof l.messages[key] === "string")) {
      lines.push(`    <string name="${key}"${ignore(key)}>${text(message as string)}</string>`);
      continue;
    }
    lines.push(`    <plurals name="${key}"${ignore(key)}>`);
    const forms = typeof message === "string" ? { other: message } : message;
    for (const [quantity, form] of Object.entries(forms)) {
      lines.push(`        <item quantity="${quantity}">${text(form as string)}</item>`);
    }
    lines.push("    </plurals>");
  }
  lines.push("</resources>", "");
  return lines.join("\n");
}

/** 报错码对应文案的表，App 里 errorText() 用它（R.string 的引用是真的，打包时不会被当作没用的资源删掉）。 */
export const ANDROID_ERRORS_FILE = "app/src/main/kotlin/cn/seekcloud/app/net/ErrorMessages.kt";

export function androidErrorMessages(): string {
  const codes = Object.keys(BASE).filter((key) => key.startsWith("error_"));
  const plural = (key: string) => ANDROID_LOCALES.some((l) => typeof l.messages[key] !== "string");
  const entries = (plurals: boolean, type: string) =>
    codes
      .filter((key) => plural(key) === plurals)
      .map((key) => `    "${key.slice("error_".length)}" to R.${type}.${key},`);
  return [
    `// ${GENERATED}`,
    "package cn.seekcloud.app.net",
    "",
    "import cn.seekcloud.app.R",
    "",
    "/** 主站接口的报错码（`{ error: { code } }`）对应的文案，和网页上的说法一样。 */", // 不是界面文案
    "internal val ERROR_MESSAGES: Map<String, Int> = mapOf(",
    ...entries(false, "string"),
    ")",
    "",
    "/** 带秒数的报错（Retry-After），按数量选单复数。 */", // 不是界面文案
    "internal val ERROR_PLURALS: Map<String, Int> = mapOf(",
    ...entries(true, "plurals"),
    ")",
    "",
  ].join("\n");
}
