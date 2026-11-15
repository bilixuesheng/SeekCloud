import { describe, expect, it } from "vitest";
import { cutMap, nextCut, step } from "./paced-text";

/** 按 want 一步步往后显示，记下每次停在哪。 */
const stops = (text: string, by: number) => {
  const blocked = cutMap(text);
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    at = nextCut(blocked, at, at + by);
    out.push(text.slice(0, at));
  }
  return out;
};

describe("回复逐字显示", () => {
  it("中文一个字一个字地出来", () => {
    expect(stops("先看代码", 1)).toEqual(["先", "先看", "先看代", "先看代码"]);
  });

  it("加粗、行内代码、英文单词不截在半截", () => {
    const shown = stops("看 **重点** 和 `src/app.ts` 里的 build", 1);
    for (const s of shown) {
      expect((s.match(/\*\*/g) ?? []).length % 2).toBe(0);
      expect((s.match(/`/g) ?? []).length % 2).toBe(0);
    }
    expect(shown).toContain("看 **重点**");
    expect(shown).not.toContain("看 **重点** 和 `src/app.ts` 里的 bu");
  });

  it("行首的标题号连同第一个字出来；表格整行出来", () => {
    const shown = stops("## 改了\n| 步骤 | 结果 |\n|---|---|\n", 1);
    expect(shown).not.toContain("#");
    expect(shown).not.toContain("## ");
    expect(shown).toContain("## 改");
    expect(shown.some((s) => s.endsWith("| 步"))).toBe(false);
    expect(shown).toContain("## 改了\n| 步骤 | 结果 |");
  });

  it("平时每秒约 40 个字，积压多了加快，6 秒内追上", () => {
    expect(step(10)).toBe(2);
    expect(step(1200)).toBe(10);
    expect(step(0)).toBe(2);
  });
});
