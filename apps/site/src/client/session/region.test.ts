import { describe, expect, it } from "vitest";
import { greetingPool } from "./greetings";
import { guessRegion, regionName } from "./region";

describe("按浏览器的使用习惯猜地区", () => {
  it("语言列表里第一个带地区的为准", () => {
    expect(guessRegion(["zh-CN", "en"], "America/Los_Angeles")).toBe("CN");
    expect(guessRegion(["en", "pt-BR"], undefined)).toBe("BR");
  });

  it("只写了语言时：几种基本只在一个地方用的语言直接对上；中文看时区", () => {
    expect(guessRegion(["ja"], undefined)).toBe("JP");
    expect(guessRegion(["zh"], "Asia/Shanghai")).toBe("CN");
    expect(guessRegion(["zh-Hant"], "Asia/Taipei")).toBe("TW");
    expect(guessRegion(["zh"], "Europe/Berlin")).toBeUndefined();
    expect(guessRegion(["en", "fr"], "Asia/Tokyo")).toBeUndefined();
  });

  it("有争议的地区、写错的语言标签都不说", () => {
    expect(guessRegion(["sq-XK"], undefined)).toBeUndefined();
    expect(guessRegion(["not a tag!", "ko"], undefined)).toBe("KR");
  });

  it("地区名用简称", () => {
    expect(regionName("CN")).toBe("中国");
    expect(regionName("HK")).toBe("香港");
    expect(regionName("US")).toBe("美国");
  });

  it('设了昵称、猜得出地区时，问候语里多一句"你是某地人吗"', () => {
    const now = new Date(2026, 10, 2, 15, 0);
    expect(greetingPool("雪生", now, "中国")).toContain("你是中国人吗，雪生");
    expect(greetingPool("雪生", now).some((g) => g.startsWith("你是"))).toBe(false);
    expect(greetingPool(null, now, "中国").some((g) => g.startsWith("你是"))).toBe(false);
  });
});
