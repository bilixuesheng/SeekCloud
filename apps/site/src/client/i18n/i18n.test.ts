import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "./catalog";
import { en } from "./en";
import {
  addMessages,
  currentLocale,
  localSetting,
  reconcileLanguage,
  resetForTests,
  resolveLocale,
  setLanguage,
  t,
  tAny,
} from "./index";
import { zh } from "./zh";

/** 文案目录（#135）：选语言的顺序、插值、单复数、叠加的目录、两份目录的键一致。 */

describe("选哪种语言", () => {
  it.each([
    // [设置, 浏览器的语言列表, 结果]
    ["en", ["zh-CN"], "en"],
    ["zh-CN", ["en-US"], "zh-CN"],
    ["auto", ["zh-CN", "en"], "zh-CN"],
    ["auto", ["ja", "zh-CN", "en"], "zh-CN"],
    ["auto", ["zh-TW"], "zh-CN"],
    ["auto", ["zh-HK", "en"], "zh-CN"],
    ["auto", ["zh"], "zh-CN"],
    ["auto", ["en-GB", "zh-CN"], "en"],
    ["auto", ["ja", "ko"], "en"],
    ["auto", [], "en"],
    [undefined, ["fr-FR", "zh-Hans-CN"], "zh-CN"],
    [null, ["ZH-cn"], "zh-CN"],
  ] as const)("设置 %s，浏览器 %j → %s", (setting, languages, expected) => {
    expect(resolveLocale(setting, languages)).toBe(expected);
  });
});

describe("取文案", () => {
  afterEach(() => resetForTests("zh-CN"));

  it("插值；{brand} 自动换成品牌名（中文界面是云上求索）", () => {
    resetForTests("zh-CN");
    expect(t("settings.windowTitle")).toBe("设置 · 云上求索");
    expect(t("time.minutesAgo", { count: 5 })).toBe("5 分钟前");
    resetForTests("en");
    expect(t("settings.windowTitle")).toBe("Settings · SeekCloud");
  });

  it("插进去的值本身带花括号：当普通文字，不再解析", () => {
    resetForTests("zh-CN");
    expect(t("time.today", { time: "{brand}" })).toBe("今天 {brand}");
  });

  it("英文按 count 分单复数", () => {
    resetForTests("en");
    expect(t("time.minutesAgo", { count: 1 })).toBe("1 minute ago");
    expect(t("time.minutesAgo", { count: 2 })).toBe("2 minutes ago");
    expect(t("error.rate_limited", { count: 30 })).toBe(
      "Too many attempts. Try again in 30 seconds.",
    );
  });

  it("叠加的目录盖掉同名的键；基准里没有的键在开发模式下提示，用 tAny 取", () => {
    resetForTests("zh-CN");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("DEV", true);
    addMessages({
      "zh-CN": { "brand.name": "某某云", "billing.title": "账单" },
      en: { "brand.name": "Some Cloud" },
    });
    expect(t("settings.windowTitle")).toBe("设置 · 某某云");
    expect(tAny("billing.title")).toBe("账单");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("billing.title"));
    resetForTests("en");
    expect(t("brand.name")).toBe("SeekCloud");
    vi.unstubAllEnvs();
    warn.mockRestore();
  });
});

describe("改语言、登录后和主站对一下", () => {
  // 测试跑在 Node 里：浏览器的存储、页面、语言列表用替身
  const html = { documentElement: { lang: "" }, title: "", querySelector: () => null };
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    html.title = "云上求索";
    vi.stubGlobal("document", html);
    vi.stubGlobal("navigator", { languages: ["zh-CN", "zh"], language: "zh-CN" });
    resetForTests("zh-CN");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetForTests("zh-CN");
  });

  it("设置里改：马上生效，记在浏览器里（刷新后还在）", () => {
    setLanguage("en", "settings");
    expect(currentLocale()).toBe("en");
    expect(html.documentElement.lang).toBe("en");
    expect(html.title).toBe("SeekCloud");
    expect(localSetting()).toBe("en");
    setLanguage("auto", "settings");
    expect(currentLocale()).toBe("zh-CN");
  });

  it("主站设的是英文、这台浏览器是中文：登录前中文，登录后英文；不用往主站存", () => {
    expect(currentLocale()).toBe("zh-CN");
    expect(reconcileLanguage("en")).toBeUndefined();
    expect(currentLocale()).toBe("en");
    expect(localSetting()).toBe("en");
  });

  it("登录页上选了英文、主站没设置过：登录后用英文，并存到主站", () => {
    setLanguage("en", "picker");
    expect(currentLocale()).toBe("en");
    expect(reconcileLanguage("auto")).toBe("en");
    expect(currentLocale()).toBe("en");
    // 登录页上选的只用一次：之后以主站为准
    expect(reconcileLanguage("zh-CN")).toBeUndefined();
    expect(currentLocale()).toBe("zh-CN");
  });

  it("登录页上选了英文、主站设的是中文：以主站为准", () => {
    setLanguage("en", "picker");
    expect(reconcileLanguage("zh-CN")).toBeUndefined();
    expect(currentLocale()).toBe("zh-CN");
  });
});

describe("两份目录", () => {
  it("键完全一样；带插值的英文也有同样的插值", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const [key, text] of Object.entries(zh)) {
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const message = en[key as keyof typeof en];
      const forms = typeof message === "string" ? [message] : Object.values(message);
      for (const form of forms) expect(names(form as string), key).toEqual(names(text));
    }
  });

  it("类型检查：英文目录少一个键、多一个键都不行", () => {
    const { "brand.name": _dropped, ...missing } = en;
    // @ts-expect-error 少了 brand.name
    const lacking: Catalog = missing;
    const extra: Catalog = {
      ...en,
      // @ts-expect-error 基准目录里没有这个键
      "no.such.key": "x",
    };
    expect(lacking).toBeDefined();
    expect(extra).toBeDefined();
  });
});
