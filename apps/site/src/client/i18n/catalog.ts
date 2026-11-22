import type { zh } from "./zh";

/** 支持的界面语言（#134）：简体中文和英文。繁体地区的浏览器也用简体中文。 */
export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** 设置里的"语言"：跟随浏览器，或者固定一种。 */
export type LanguageSetting = "auto" | Locale;
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["auto", ...LOCALES];

/** 每种语言在选择器里怎么写：都用它自己的文字写，看不懂当前界面语言的人也找得到。 */
export const LOCALE_NAMES: Record<Locale, string> = { "zh-CN": "简体中文", en: "English" };

/** 英文按 Intl.PluralRules 分单复数（one、other……），中文不分。 */
export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Message = string | Plural;

export type MessageKey = keyof typeof zh;

/** 一种语言的目录：键和中文目录完全一样。 */
export type Catalog = { readonly [K in MessageKey]: Message };

/** 一条文案里的 {名字}。 */
type Names<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Names<Rest>
  : never;

/** 调用时要传的插值：中文目录里写着的那些，{brand} 自动填。 */
export type Params<K extends MessageKey> = Exclude<Names<(typeof zh)[K]>, "brand">;
