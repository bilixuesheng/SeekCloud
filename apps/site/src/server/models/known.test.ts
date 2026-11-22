import { describe, expect, it } from "vitest";
import { normalizeModelId, recognizeModel, searchKnownModels } from "./known";

/** 认得出来的模型：自定义接口添加模型、获取可用模型时按 ID 在 dsh 内置目录里找资料。 */

describe("认得出来的模型", () => {
  it("比较用的 ID：去掉路径前缀和冒号后缀，点和下划线当成连字符", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
    expect(normalizeModelId("accounts/fireworks/models/qwen3_coder")).toBe("qwen3-coder");
    expect(normalizeModelId("deepseek/deepseek-r1:free")).toBe("deepseek-r1");
    expect(normalizeModelId(" GPT-5.1 ")).toBe("gpt-5-1");
  });

  it("同一个模型在官方和转售的提供方下都有：取官方的那份（上下文窗口、价格、思考档位）", () => {
    const sonnet = recognizeModel("anthropic/claude-sonnet-4.5");
    expect(sonnet).toMatchObject({
      id: "claude-sonnet-4-5",
      provider: "anthropic",
      api: "anthropic-messages",
      contextWindow: 200_000,
      maxTokens: 64_000,
      cost: [3, 15],
    });
    expect(sonnet?.efforts).toContain("off");
  });

  it("档位的参数值和档位名不一样的带上（GPT-5.1 关闭思考发 none）；不思考的模型只有 off", () => {
    expect(recognizeModel("gpt-5.1")).toMatchObject({ provider: "openai", wire: { off: "none" } });
    expect(recognizeModel("gpt-5")?.efforts).not.toContain("off");
    expect(recognizeModel("qwen/qwen3-coder")?.efforts).toEqual(["off"]);
  });

  it("只在转售的提供方下有的也认（glm-4.6 不在智谱自己的目录里）；认不出来的为空", () => {
    expect(recognizeModel("glm-4.6")?.contextWindow).toBeGreaterThan(190_000);
    expect(recognizeModel("my-private-model-7b")).toBeUndefined();
  });

  it("包月套餐记的 0 价格不当成模型的价钱；在那个提供方自己的列表里照目录", () => {
    const viaPlan = searchKnownModels("", { provider: "qwen-token-plan", limit: 500 });
    expect(viaPlan.some((m) => m.cost?.[0] === 0)).toBe(true);
    expect(searchKnownModels("kimi-k2.6")[0]).toMatchObject({ provider: "moonshotai" });
    for (const m of searchKnownModels("", { limit: 5000 })) {
      expect(m.cost === null || m.cost[0] > 0 || m.cost[1] > 0).toBe(true);
    }
  });

  it("搜索：每个词都要出现在 ID 或名称里；ID 完全一样的排最前；只搜一个提供方时照目录的顺序", () => {
    const hits = searchKnownModels("claude sonnet 4.5");
    expect(hits[0]?.id).toBe("claude-sonnet-4-5");
    expect(hits.every((m) => /sonnet/i.test(`${m.id} ${m.name}`))).toBe(true);
    expect(searchKnownModels("gpt-5")[0]?.id).toBe("gpt-5");
    const groq = searchKnownModels("", { provider: "groq" });
    expect(groq.length).toBeGreaterThan(0);
    expect(groq.every((m) => m.provider === "groq")).toBe(true);
    expect(searchKnownModels("", { limit: 3 })).toHaveLength(3);
  });
});
