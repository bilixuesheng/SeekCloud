import { fitEffort, THINKING_EFFORTS } from "@seekcloud/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ModelInfo, ModelPicker, nearest, step } from "./ModelPicker";

const all = THINKING_EFFORTS;
const noOff = ["low", "high", "max"] as const;

describe("思考强度的滑块", () => {
  it("松手吸到最近的一档；模型不支持的那档跳过", () => {
    expect(nearest(all, 0)).toBe("off");
    expect(nearest(all, 0.3)).toBe("low");
    expect(nearest(all, 0.6)).toBe("high");
    expect(nearest(all, 0.9)).toBe("max");
    expect(nearest(noOff, 0)).toBe("low");
    expect(nearest(noOff, 0.1)).toBe("low");
  });

  it("方向键换到下一个支持的档位，到头了不动", () => {
    expect(step(all, "high", 1)).toBe("max");
    expect(step(all, "max", 1)).toBe("max");
    expect(step(all, "low", -1)).toBe("off");
    expect(step(noOff, "low", -1)).toBe("low");
    expect(step(["off", "high"], "off", 1)).toBe("high");
  });

  it("换模型、用默认值时落到模型支持的档位：支持就不变，不支持取最近的，一样近取低的", () => {
    expect(fitEffort(all, "max")).toBe("max");
    expect(fitEffort(noOff, "off")).toBe("low");
    expect(fitEffort(["off", "max"], "low")).toBe("off");
    expect(fitEffort(["off", "max"], "high")).toBe("max");
    expect(fitEffort(["low", "max"], "high")).toBe("low");
    expect(fitEffort([], "high")).toBeUndefined();
  });
});

describe("模型和思考强度的按钮", () => {
  const models: ModelInfo[] = [
    { id: "flash", name: "DeepSeek Flash", description: "", efforts: [...all] },
  ];
  const render = (effort: "high" | "max") =>
    renderToStaticMarkup(
      <ModelPicker
        models={models}
        model="flash"
        effort={effort}
        defaultEffort="high"
        onChange={() => undefined}
      />,
    );

  it('写模型名加档位，"最高"单独一个样式（蓝紫渐变）', () => {
    expect(render("high")).toContain('DeepSeek Flash <span class="trigger-effort high">高</span>');
    expect(render("max")).toContain('<span class="trigger-effort max">最高</span>');
  });
});
