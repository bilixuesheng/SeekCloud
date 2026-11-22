import { describe, expect, it } from "vitest";
import { fitLevels, levelsFromKnown, protocolRules } from "./reasoning";
import { costText, parseTokens, priceText, shortTokens, tokenInputText } from "./tokens";

describe("token 数的写法", () => {
  it("读：K、M、万、千分位、纯数字；不对的是 NaN，空的是不填", () => {
    expect(parseTokens("128K")).toBe(128_000);
    expect(parseTokens("128k")).toBe(128_000);
    expect(parseTokens("1M")).toBe(1_000_000);
    expect(parseTokens("1.5 M")).toBe(1_500_000);
    expect(parseTokens("2.3M")).toBe(2_300_000);
    expect(parseTokens("12.8万")).toBe(128_000);
    expect(parseTokens("131,072")).toBe(131_072);
    expect(parseTokens("131072")).toBe(131_072);
    expect(parseTokens("")).toBeUndefined();
    expect(parseTokens("  ")).toBeUndefined();
    expect(parseTokens("abc")).toBeNaN();
    expect(parseTokens("1.5")).toBeNaN();
    expect(parseTokens("-5K")).toBeNaN();
  });

  it("输入框里写成能原样读回来的最短写法；列表上写三位有效数字", () => {
    expect(tokenInputText(1_000_000)).toBe("1M");
    expect(tokenInputText(128_000)).toBe("128K");
    expect(tokenInputText(131_072)).toBe("131072");
    expect(tokenInputText(null)).toBe("");
    for (const n of [1_000_000, 128_000, 131_072, 2_500_000]) {
      expect(parseTokens(tokenInputText(n))).toBe(n);
    }
    expect(shortTokens(131_072)).toBe("131K");
    expect(shortTokens(1_048_576)).toBe("1.05M");
    expect(shortTokens(200_000)).toBe("200K");
    expect(shortTokens(98_304)).toBe("98.3K");
    expect(shortTokens(512)).toBe("512");
  });

  it("价格：整数不带小数，别的两位小数，很小的两位有效数字", () => {
    expect(priceText(15)).toBe("$15");
    expect(priceText(0.3)).toBe("$0.30");
    expect(priceText(1.25)).toBe("$1.25");
    expect(priceText(0.055)).toBe("$0.055");
    expect(priceText(0)).toBe("$0");
    expect(costText([0.3, 1.2])).toBe("输入 $0.30 / 输出 $1.20");
  });
});

describe("思考档位按协议", () => {
  it("每种协议能选的档位和参数值能不能改", () => {
    expect(protocolRules("openai-completions")).toMatchObject({ editableValues: true });
    expect(protocolRules("anthropic-messages").levels).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(protocolRules("anthropic-messages", true).levels).not.toContain("minimal");
    expect(protocolRules("google-generative-ai")).toEqual({
      levels: ["minimal", "low", "medium", "high"],
      editableValues: false,
    });
  });

  it("换成 Gemini：去掉关闭和 Gemini 没有的档位，参数值改回档位名；什么都不剩时用默认的", () => {
    expect(
      fitLevels({ off: "none", low: "lo", high: "hi", max: "max" }, "google-generative-ai"),
    ).toEqual({ low: "low", high: "high" });
    expect(fitLevels({ off: null, max: "max" }, "google-generative-ai")).toEqual({
      low: "low",
      medium: "medium",
      high: "high",
    });
    expect(fitLevels(null, "google-generative-ai")).toBeNull();
    // OpenAI 系保留改过的参数值
    expect(fitLevels({ off: "none", high: "high" }, "openai-responses")).toEqual({
      off: "none",
      high: "high",
    });
  });

  it("认得出来的模型：按目录的档位和参数值（GPT-5.1 关闭发 none）；不思考的为空；按接口的协议适配", () => {
    expect(
      levelsFromKnown(
        { efforts: ["off", "low", "medium", "high"], wire: { off: "none" } },
        "openai-completions",
      ),
    ).toEqual({ off: "none", low: "low", medium: "medium", high: "high" });
    expect(levelsFromKnown({ efforts: ["off"] }, "openai-completions")).toBeNull();
    // Claude 的 xhigh、max 在按预算思考时没有区别，不给
    expect(
      levelsFromKnown({ efforts: ["off", "low", "high", "xhigh", "max"] }, "anthropic-messages"),
    ).toEqual({ off: null, low: "low", high: "high" });
  });
});
