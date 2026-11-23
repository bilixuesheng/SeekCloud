import { describe, expect, it } from "vitest";
import { regionName } from "../i18n/greetings-zh";
import { pickGreeting } from "./greetings";
import { guessRegion } from "./region";

describe("按浏览器的使用习惯猜地区", () => {
  it("语言列表优先：按顺序第一个说得出地区的为准，时区不看", () => {
    expect(guessRegion(["zh-CN", "en"], "America/Los_Angeles")).toBe("CN");
    expect(guessRegion(["pt-BR", "en"], "Asia/Tokyo")).toBe("BR");
    expect(guessRegion(["ja"], "Europe/Berlin")).toBe("JP");
  });

  it("英文不当强信号：列表里有别的语言就看别的；只有英文时时区优先", () => {
    expect(guessRegion(["en-US", "zh-CN"], "America/New_York")).toBe("CN");
    expect(guessRegion(["en-US", "ja"], undefined)).toBe("JP");
    expect(guessRegion(["en-US"], "Asia/Shanghai")).toBe("CN");
    expect(guessRegion(["en-US"], "America/New_York")).toBe("US");
    expect(guessRegion(["en-GB"], "UTC")).toBe("GB");
  });

  it("中文只写了文字时：简体是中国，不因为时区在台湾就当成台湾", () => {
    expect(guessRegion(["zh-Hans"], "Asia/Taipei")).toBe("CN");
    expect(guessRegion(["en-US", "zh-Hans"], "Asia/Taipei")).toBe("CN");
    expect(guessRegion(["zh-Hant"], "Asia/Hong_Kong")).toBe("HK");
    expect(guessRegion(["zh-Hant"], "Asia/Taipei")).toBeUndefined();
  });

  it("语言说不出来时看时区（包括浏览器报的旧名字）", () => {
    expect(guessRegion(["zh"], "Asia/Shanghai")).toBe("CN");
    expect(guessRegion(["fr"], "Asia/Calcutta")).toBe("IN");
    expect(guessRegion(["fr"], "UTC")).toBeUndefined();
    expect(guessRegion([], undefined)).toBeUndefined();
  });

  it("台湾、有争议的地区、写错的语言标签都不说", () => {
    expect(guessRegion(["zh-TW"], "Asia/Shanghai")).toBeUndefined();
    expect(guessRegion(["zh"], "Asia/Taipei")).toBeUndefined();
    expect(guessRegion(["en-US"], "Asia/Taipei")).toBeUndefined();
    expect(guessRegion(["sq-XK"], undefined)).toBeUndefined();
    expect(guessRegion(["not a tag!", "ko"], undefined)).toBe("KR");
  });

  it("大陆、香港、澳门都说中国；台湾不说", () => {
    expect(regionName("CN")).toBe("中国");
    expect(regionName("HK")).toBe("中国");
    expect(regionName("MO")).toBe("中国");
    expect(regionName("TW")).toBeUndefined();
    expect(regionName("US")).toBe("美国");
  });

  it('设了昵称、猜得出地区时，才会挑到"你是某地人吗"', () => {
    const now = new Date(2026, 10, 2, 15, 0);
    const pick = (name: string | null, region?: string) =>
      pickGreeting({ name, now, random: () => 0.3, region });
    expect(pick("雪生", "CN")).toBe("你是中国人吗，雪生");
    expect(pick("雪生", "HK")).toBe("你是中国人吗，雪生");
    expect(pick("雪生", "JP")).toBe("你是日本人吗，雪生");
    expect(pick("雪生").startsWith("你是")).toBe(false);
    expect(pick(null, "CN").startsWith("你是")).toBe(false);
  });
});
