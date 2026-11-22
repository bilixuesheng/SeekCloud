import { fitEffort, THINKING_EFFORTS } from "@seekcloud/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ModelInfo, ModelPicker, nearest, step } from "./ModelPicker";

const all = THINKING_EFFORTS;
const deepseek = ["off", "low", "high", "max"] as const;
const noOff = ["low", "high", "max"] as const;

describe("思考强度的滑块", () => {
  it("只画模型支持的档位，等距排开；松手吸到最近的一档", () => {
    expect(nearest(deepseek, 0)).toBe("off");
    expect(nearest(deepseek, 0.3)).toBe("low");
    expect(nearest(deepseek, 0.6)).toBe("high");
    expect(nearest(deepseek, 0.9)).toBe("max");
    expect(nearest(noOff, 0)).toBe("low");
    expect(nearest(noOff, 0.1)).toBe("low");
    expect(nearest(all, 0.5)).toBe("medium");
  });

  it("方向键换到下一档，到头了不动", () => {
    expect(step(deepseek, "high", 1)).toBe("max");
    expect(step(deepseek, "max", 1)).toBe("max");
    expect(step(deepseek, "low", -1)).toBe("off");
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
    {
      id: "deepseek/deepseek-flash",
      provider: "deepseek",
      providerName: "DeepSeek 官方",
      name: "DeepSeek Flash",
      description: "",
      vision: false,
      efforts: [...deepseek],
    },
  ];
  const render = (effort: "high" | "max") =>
    renderToStaticMarkup(
      <ModelPicker
        models={models}
        model="deepseek/deepseek-flash"
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
