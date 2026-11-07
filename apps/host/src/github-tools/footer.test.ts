import { describe, expect, it } from "vitest";
import { FOOTER_LINE, withFooter } from "./footer";

const footer = `\n\n---\n${FOOTER_LINE}`;

describe("署名", () => {
  it("正文末尾加一次署名", () => {
    expect(withFooter("修好了登录页。")).toBe(`修好了登录页。${footer}`);
  });

  it("已经带署名（Agent 自己写的、或者改的是旧正文）：去掉重复的，只留一个", () => {
    expect(withFooter(`修好了。${footer}`)).toBe(`修好了。${footer}`);
    expect(withFooter(`修好了。${footer}${footer}\n`)).toBe(`修好了。${footer}`);
    expect(withFooter(`修好了。\n${FOOTER_LINE}`)).toBe(`修好了。${footer}`);
  });

  it("正文里别处的分隔线不受影响；空正文只有署名", () => {
    expect(withFooter("上半\n\n---\n\n下半")).toBe(`上半\n\n---\n\n下半${footer}`);
    expect(withFooter(undefined)).toBe(`---\n${FOOTER_LINE}`);
  });
});
