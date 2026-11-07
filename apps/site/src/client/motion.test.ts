import { describe, expect, it } from "vitest";
import { sheetShouldClose } from "./Motion";

describe("底部弹层拖动关闭", () => {
  it("拉过 90 像素就关，不然弹回去", () => {
    expect(sheetShouldClose(91, 0)).toBe(true);
    expect(sheetShouldClose(80, 0.1)).toBe(false);
  });

  it("甩得够快也关；只动了几个像素不算甩", () => {
    expect(sheetShouldClose(30, 0.8)).toBe(true);
    expect(sheetShouldClose(6, 2)).toBe(false);
  });
});
