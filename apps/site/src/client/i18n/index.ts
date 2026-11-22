import { createElement, Fragment, type ReactNode, useSyncExternalStore } from "react";
import {
  type Catalog,
  type LanguageSetting,
  LOCALES,
  type Locale,
  type Message,
  type MessageKey,
  type Params,
} from "./catalog";
import { en } from "./en";
import { zh } from "./zh";

/**
 * 界面文案（#135，规格 #134）：按键取文案，{名字} 插值，英文分单复数；选语言、叠加目录、跟着语言换 <html lang>、
 * 标题和 PWA 清单。不用大的国际化框架，就这一个文件。
 *
 * 选哪种语言：设置里选的 → 浏览器的语言列表里第一个支持的（zh 开头的都算中文）→ 英文。
 * 设置存在主站（跟着管理员），同时记在浏览器里，免得刷新时先闪一下别的语言；登录之前只看浏览器
 * （登录页角上可以切换，选的也记在浏览器里，登录后主站没设置过就用它）。
 */

export * from "./catalog";

const BASE: Record<Locale, Catalog> = { "zh-CN": zh, en };

/** 浏览器里记的：主站上的设置（上次读到的）、登录前在登录页上选的。 */
const STORED = "seekcloud:language";
const PICKED = "seekcloud:language-picked";

const read = (key: string): LanguageSetting | undefined => {
  try {
    const value = localStorage.getItem(key);
    return value === "auto" || (LOCALES as readonly string[]).includes(value ?? "")
      ? (value as LanguageSetting)
      : undefined;
  } catch {
    return undefined;
  }
};
const write = (key: string, value: LanguageSetting | undefined) => {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
};

/** 选哪种语言：设置里选了就用它；"跟随浏览器"时看浏览器的语言列表，第一个支持的为准；都不支持用英文。 */
export function resolveLocale(
  setting: LanguageSetting | null | undefined,
  languages: readonly string[],
): Locale {
  if (setting && setting !== "auto") return setting;
  for (const tag of languages) {
    const lang = tag.toLowerCase();
    // 繁体地区（zh-TW、zh-HK）也用简体中文，不落到英文
    if (lang === "zh" || lang.startsWith("zh-")) return "zh-CN";
    if (lang === "en" || lang.startsWith("en-")) return "en";
  }
  return "en";
}

const browserLanguages = (): readonly string[] => {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
};

/** 这台浏览器上的设置：登录页上选过的优先，再是上次从主站读到的。 */
export const localSetting = (): LanguageSetting => read(PICKED) ?? read(STORED) ?? "auto";

let current: Locale = resolveLocale(localSetting(), browserLanguages());
const overlays: Partial<Record<Locale, Partial<Record<string, Message>>>> = {};
const listeners = new Set<() => void>();

export const currentLocale = (): Locale => current;

/** 按 Intl 分单复数时用的语言标签。 */
const plurals = new Map<Locale, Intl.PluralRules>();
const pluralOf = (locale: Locale) => {
  let rules = plurals.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    plurals.set(locale, rules);
  }
  return rules;
};

function lookup(locale: Locale, key: string): Message | undefined {
  return overlays[locale]?.[key] ?? (BASE[locale] as Record<string, Message>)[key];
}

/** 插值：{名字} 换成传进来的值，一遍换完，插进去的值里有花括号也当普通文字。没传的 {brand} 换成品牌名。 */
function fill(text: string, values: Record<string, unknown>, locale: Locale): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (name in values) return String(values[name]);
    if (name === "brand") return String(lookup(locale, "brand.name"));
    return whole;
  });
}

function pick(message: Message, values: Record<string, unknown>, locale: Locale): string {
  if (typeof message === "string") return message;
  const count = Number(values.count ?? 0);
  return message[pluralOf(locale).select(count)] ?? message.other;
}

type Args<K extends MessageKey> = [Params<K>] extends [never]
  ? []
  : [values: Record<Params<K>, string | number>];

/** 取一条文案（当前语言）。 */
export function t<K extends MessageKey>(key: K, ...args: Args<K>): string {
  const values = (args[0] ?? {}) as Record<string, unknown>;
  const message = lookup(current, key) ?? lookup("zh-CN", key) ?? key;
  return fill(pick(message, values, current), values, current);
}

/**
 * 文案里要插入的是元素（比如 <code>pnpm admin:reset-password</code>）时用这个：
 * 按 {名字} 切开，文字原样，名字换成传进来的元素。
 */
export function tRich<K extends MessageKey>(
  key: K,
  values: Record<Params<K>, ReactNode>,
): ReactNode {
  const message = lookup(current, key) ?? key;
  const text = pick(message, {}, current);
  const parts = text.split(/(\{\w+\})/);
  return createElement(
    Fragment,
    null,
    ...parts.map((part, i) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      if (!name) return part;
      if (name in values) {
        return createElement(Fragment, { key: i }, (values as Record<string, ReactNode>)[name]);
      }
      return name === "brand" ? String(lookup(current, "brand.name")) : part;
    }),
  );
}

/** 页面标题：前缀 · 品牌名；没有前缀就是品牌名。 */
export const pageTitle = (prefix?: string): string => {
  const brand = t("brand.name");
  return prefix ? `${prefix} · ${brand}` : brand;
};

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** 当前的语言；换了语言时用它的组件跟着重画。 */
export const useLocale = (): Locale =>
  useSyncExternalStore(subscribe, currentLocale, currentLocale);

/** 组件里取文案：t 本身就是全局的，这个钩子只是让组件在换语言时重画。 */
export function useT(): typeof t {
  useLocale();
  return t;
}

/** <html lang>、标题、PWA 清单跟着语言（public/locale-boot.js 在页面画出来之前做过一遍同样的事）。 */
function applyToDocument(previousTitle?: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = current;
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifest) manifest.href = `/manifest.${current}.webmanifest`;
  // 页面自己设了"xxx · 品牌名"的标题由页面换；只是品牌名的（首页这些）这里换
  if (!previousTitle || document.title === previousTitle) document.title = pageTitle();
}

function change(next: Locale): void {
  if (next === current) return;
  const before = pageTitle();
  current = next;
  applyToDocument(before);
  for (const fn of listeners) fn();
}

applyToDocument();

/**
 * 改语言。from = "settings"：设置里改的（调用方同时存到主站）；"picker"：登录页角上切换的，
 * 只记在这台浏览器上，登录后主站没设置过时再存上去（syncLanguage）。
 */
export function setLanguage(setting: LanguageSetting, from: "settings" | "picker"): void {
  if (from === "settings") {
    write(STORED, setting);
    write(PICKED, undefined);
  } else {
    write(PICKED, setting);
  }
  change(resolveLocale(setting, browserLanguages()));
}

/**
 * 登录以后对一下主站上的设置：
 * - 登录页上选过、主站上是"跟随浏览器"（没设置过）：把选的存到主站；
 * - 不然以主站为准（换了一台浏览器语言是中文的设备，主站设的是英文：登录前中文，登录后英文）。
 * 返回要存到主站的值（调用方去 PUT）；不用存时为空。
 */
export function reconcileLanguage(server: LanguageSetting): LanguageSetting | undefined {
  const picked = read(PICKED);
  const upload = picked && server === "auto" && picked !== "auto" ? picked : undefined;
  const setting = upload ?? server;
  write(STORED, setting);
  write(PICKED, undefined);
  change(resolveLocale(setting, browserLanguages()));
  return upload;
}

/**
 * 叠加一层目录（ADR 0010：下游版本盖掉几条文案，不改主干的文件）。只能盖掉已有的键：
 * 基准目录里没有的键在开发模式下提示，照样收下（下游自己的组件可以用 tAny 取）。
 */
export function addMessages(
  layer: Partial<Record<Locale, Partial<Record<string, Message>>>>,
): void {
  for (const locale of LOCALES) {
    const entries = layer[locale];
    if (!entries) continue;
    for (const key of Object.keys(entries)) {
      if (!(key in zh) && import.meta.env?.DEV) {
        // 不是界面文案：给下游的开发者看的提示
        console.warn(`文案目录：叠加的目录里有基准目录没有的键 ${key}（${locale}）`);
      }
    }
    overlays[locale] = { ...overlays[locale], ...entries };
  }
  for (const fn of listeners) fn();
}

/** 取一条不在基准目录里的文案（下游叠加的）；没有时返回键本身。 */
export function tAny(key: string, values: Record<string, unknown> = {}): string {
  const message = lookup(current, key) ?? key;
  return fill(pick(message, values, current), values, current);
}

/** 测试用：直接切到某种语言，清掉叠加的目录。 */
export function resetForTests(locale: Locale): void {
  for (const l of LOCALES) delete overlays[l];
  current = locale;
  for (const fn of listeners) fn();
}
