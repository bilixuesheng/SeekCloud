import { appEn } from "./app-en";
import { appZh } from "./app-zh";
import type { Locale, Message } from "./catalog";
import { en } from "./en";
import { zh } from "./zh";

/**
 * 从文案目录生成安卓 App 的 strings.xml（#204）：App 的文案写在 app-zh.ts、app-en.ts，品牌名用网页目录里的。
 * 生成的文件是 apps/android/app/src/main/res/values/strings.xml 和 values-zh/strings.xml，进仓库；
 * 主站的测试（android.test.ts）核对它们是最新的。
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

/** 默认的资源（values）用英文：系统语言 App 不支持时用它，和网页一样。values-zh 包括繁体地区。 */
export const ANDROID_LOCALES: {
  locale: Locale;
  dir: string;
  messages: AppCatalog;
  brand: string;
}[] = [
  { locale: "en", dir: "values", messages: appEn, brand: en["brand.name"] as string },
  { locale: "zh-CN", dir: "values-zh", messages: appZh, brand: zh["brand.name"] as string },
];

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
const HEADER =
  "<!-- 由 apps/site/src/client/i18n/app-zh.ts、app-en.ts 生成，不要手改；重新生成的命令是 apps/site/package.json 里的 android:strings -->"; // 不是界面文案

/** 一种语言的 strings.xml 的内容。 */
export function androidStrings(locale: Locale): string {
  const target = ANDROID_LOCALES.find((l) => l.locale === locale);
  if (!target) throw new Error(`no Android resources for ${locale}`);
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', HEADER, "<resources>"];
  for (const key of Object.keys(appZh) as AppKey[]) {
    if (!KEY.test(key)) throw new Error(`${key}: not a valid Android resource name`);
    const order = names(appZh[key]);
    const own = names(target.messages[key]);
    if (own.length !== order.length || own.some((n) => !order.includes(n))) {
      throw new Error(`${key}: placeholders differ between languages`);
    }
    const message = target.messages[key];
    const text = (t: string) => androidText(t, target.brand, order, key);
    if (ANDROID_LOCALES.every((l) => typeof l.messages[key] === "string")) {
      lines.push(`    <string name="${key}">${text(message as string)}</string>`);
      continue;
    }
    lines.push(`    <plurals name="${key}">`);
    const forms = typeof message === "string" ? { other: message } : message;
    for (const [quantity, form] of Object.entries(forms)) {
      lines.push(`        <item quantity="${quantity}">${text(form as string)}</item>`);
    }
    lines.push("    </plurals>");
  }
  lines.push("</resources>", "");
  return lines.join("\n");
}
