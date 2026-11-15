import { describe, expect, it } from "vitest";
import { greetingPool } from "./greetings";
import { guessRegion, regionName } from "./region";

describe("按浏览器的使用习惯猜地区", () => {
  it("浏览器语言列表优先：第一个带地区的为准，时区不看", () => {
    expect(guessRegion(["zh-CN", "en"], "America/Los_Angeles")).toBe("CN");
    expect(guessRegion(["en", "pt-BR"], "Asia/Tokyo")).toBe("BR");
  });

  it("语言都没带地区时，几种基本只在一个地方用的语言直接对上", () => {
    expect(guessRegion(["en", "ja"], "Europe/Berlin")).toBe("JP");
  });

  it("语言说不出来时看时区（包括浏览器报的旧名字）", () => {
    expect(guessRegion(["en"], "Asia/Shanghai")).toBe("CN");
    expect(guessRegion(["zh"], "Asia/Hong_Kong")).toBe("HK");
    expect(guessRegion(["en", "fr"], "Asia/Calcutta")).toBe("IN");
    expect(guessRegion(["en"], "UTC")).toBeUndefined();
    expect(guessRegion(["en"], undefined)).toBeUndefined();
  });

  it("台湾、有争议的地区、写错的语言标签都不说", () => {
    expect(guessRegion(["zh-TW"], "Asia/Shanghai")).toBeUndefined();
    expect(guessRegion(["zh"], "Asia/Taipei")).toBeUndefined();
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

  it('设了昵称、猜得出地区时，问候语里多一句"你是某地人吗"', () => {
    const now = new Date(2026, 10, 2, 15, 0);
    expect(greetingPool("雪生", now, "中国")).toContain("你是中国人吗，雪生");
    expect(greetingPool("雪生", now).some((g) => g.startsWith("你是"))).toBe(false);
    expect(greetingPool(null, now, "中国").some((g) => g.startsWith("你是"))).toBe(false);
  });
});
