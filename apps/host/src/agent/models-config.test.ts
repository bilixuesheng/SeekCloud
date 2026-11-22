import type { SandboxProvider } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_ROUTE,
  dshRoute,
  MODEL_KEY_ENV,
  modelsPatch,
  modelsVersion,
} from "./models-config";

/** 沙箱里 dsh 的模型配置（#188）：主站下发的提供方怎么写进 dsh 的 --patch。 */

const GATEWAY = "http://10.88.0.1:7070";
const deepseek: SandboxProvider = {
  id: "deepseek",
  kind: "deepseek",
  name: "DeepSeek 官方",
  models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
};
const custom: SandboxProvider = {
  id: "my-gateway",
  kind: "custom",
  name: "公司网关",
  api: "anthropic-messages",
  models: [
    {
      id: "reasoner",
      name: "推理模型",
      contextWindow: 200_000,
      maxTokens: 32_000,
      input: ["text", "image"],
      reasoningEfforts: { off: null, high: "high", max: "xhigh" },
      compat: { supportsDeveloperRole: false },
    },
    { id: "plain", input: ["text"] },
  ],
};
const catalog: SandboxProvider = { id: "openai", kind: "catalog", name: "OpenAI" };
const catalogCustom: SandboxProvider = {
  id: "moonshotai",
  kind: "catalog",
  name: "Kimi",
  models: [{ id: "kimi-only", input: ["text"], reasoningEfforts: { high: "high" } }],
};

const parse = (text: string) =>
  JSON.parse(text) as Array<{ id: string; config: Record<string, unknown> }>;

describe("dsh 的模型配置", () => {
  it("别的提供方写进 llm-pi-ai：地址指到宿主机的 /v1/providers/<id>，key 引用环境变量；不带真 key、不带提供方的地址", () => {
    const [pi] = parse(modelsPatch([deepseek, custom, catalog], `${GATEWAY}/`));
    expect(pi?.id).toBe("llm-pi-ai");
    const providers = pi?.config.providers as Record<string, Record<string, unknown>>;
    expect(Object.keys(providers)).toEqual(["my-gateway", "openai"]);
    expect(providers["my-gateway"]).toEqual({
      apiKeyEnv: MODEL_KEY_ENV,
      displayName: "公司网关",
      baseURL: `${GATEWAY}/v1/providers/my-gateway`,
      api: "anthropic-messages",
      models: [
        {
          id: "reasoner",
          name: "推理模型",
          contextWindow: 200_000,
          maxTokens: 32_000,
          input: ["text", "image"],
          reasoningEfforts: { off: null, high: "high", max: "xhigh" },
          compat: { supportsDeveloperRole: false },
        },
        { id: "plain", input: ["text"] },
      ],
    });
    // 目录里的没改过模型列表：只写地址和 key，协议、模型由 dsh 的目录给
    expect(providers.openai).toEqual({
      apiKeyEnv: MODEL_KEY_ENV,
      displayName: "OpenAI",
      baseURL: `${GATEWAY}/v1/providers/openai`,
    });
  });

  it("目录里的提供方改过模型列表：写模型，但推理等级不写（由目录给）", () => {
    const [pi] = parse(modelsPatch([catalogCustom], GATEWAY));
    const providers = pi?.config.providers as Record<string, Record<string, unknown>>;
    expect(providers.moonshotai?.models).toEqual([{ id: "kimi-only", input: ["text"] }]);
    expect(providers.moonshotai?.api).toBeUndefined();
  });

  it("DeepSeek 照旧走 llm-deepseek：只有内置的两个时不写；有 dsh 不认识的模型（新发布的）时写模型列表", () => {
    expect(parse(modelsPatch([deepseek], GATEWAY))).toEqual([
      { id: "llm-pi-ai", config: { providers: {} } },
    ]);
    const withNew = parse(
      modelsPatch(
        [
          {
            ...deepseek,
            models: [
              { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", input: ["text", "image"] },
              { id: "deepseek-v5", contextWindow: 2_000_000 },
            ],
          },
        ],
        GATEWAY,
      ),
    );
    expect(withNew[1]).toEqual({
      id: "llm-deepseek",
      config: {
        models: [
          { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", inputModalities: ["text", "image"] },
          { id: "deepseek-v5", contextWindow: 2_000_000, inputModalities: ["text"] },
        ],
      },
    });
  });

  it("用哪个路由：DeepSeek 是 deepseek-official；别的是 Provider ID；自定义的模型没声明推理等级时不带思考强度", () => {
    const providers = [deepseek, custom, catalog];
    expect(dshRoute(providers, "deepseek", "deepseek-flash")).toEqual({
      route: DEEPSEEK_ROUTE,
      reasoning: true,
    });
    // 旧版本的主站不填提供方：DeepSeek
    expect(dshRoute(undefined, undefined, "deepseek-flash").route).toBe(DEEPSEEK_ROUTE);
    expect(dshRoute(providers, "my-gateway", "reasoner")).toEqual({
      route: "my-gateway",
      reasoning: true,
    });
    expect(dshRoute(providers, "my-gateway", "plain")).toEqual({
      route: "my-gateway",
      reasoning: false,
    });
    expect(dshRoute(providers, "openai", "gpt-5.1")).toEqual({ route: "openai", reasoning: true });
  });

  it("配置的版本：内容变了才变", () => {
    expect(modelsVersion([deepseek])).toBe(modelsVersion([{ ...deepseek }]));
    expect(modelsVersion([deepseek])).not.toBe(modelsVersion([deepseek, catalog]));
    expect(modelsVersion(undefined)).toBe(modelsVersion([]));
  });
});
