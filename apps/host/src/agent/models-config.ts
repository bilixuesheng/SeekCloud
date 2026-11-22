import { createHash } from "node:crypto";
import type { SandboxModel, SandboxProvider } from "@seekcloud/protocol";

/**
 * 沙箱里 dsh 的模型配置（#188）：主站下发的提供方写成 dsh 的一层 --patch，启动 dsh 时叠在基线配置前面。
 *
 * - DeepSeek 官方照旧走 dsh 的 llm-deepseek（地址和 key 是 DEEPSEEK_BASE_URL、DEEPSEEK_API_KEY）；主站的模型列表里
 *   有 dsh 内置目录不认识的模型（DeepSeek 新发布的、管理员自己加的）时，把列表写进 llm-deepseek.models；
 * - 别的提供方写进 llm-pi-ai.providers：地址都指到宿主机本地的 /v1/providers/<id>（经主站的透明转发，主站换上真 key），
 *   key 引用环境变量 MODEL_KEY_ENV（里面是会话临时令牌）；目录里的提供方没改过模型列表时只写地址和 key，
 *   其余（协议、模型）由 dsh 的目录给。
 *
 * 写成 JSON：JSON 本来就是合法的 YAML，不用另外引入 YAML 库。
 */

/** 沙箱里放模型配置的地方（root 拥有，dsh 只读）。 */
export const MODELS_PATCH_PATH = "/etc/seekcloud/models.patch.yml";
/** dsh 读 key 的环境变量：值是会话临时令牌。名字里带 KEY，dsh 给 Agent 跑的命令会去掉它。 */
export const MODEL_KEY_ENV = "SEEKCLOUD_MODEL_API_KEY";
/** DeepSeek 官方在 dsh 里的路由名。 */
export const DEEPSEEK_ROUTE = "deepseek-official";
/** dsh 0.2.2 内置目录里的 DeepSeek 模型。 */
const DEEPSEEK_BUILTIN = new Set(["deepseek-flash", "deepseek-v4-pro"]);

function piModel(m: SandboxModel, withReasoning: boolean): Record<string, unknown> {
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
    ...(m.input?.length ? { input: m.input } : {}),
    ...(withReasoning && m.reasoningEfforts ? { reasoningEfforts: m.reasoningEfforts } : {}),
    ...(m.compat && Object.keys(m.compat).length > 0 ? { compat: m.compat } : {}),
  };
}

/** 生成 dsh 的模型配置。gateway 是沙箱里连宿主机模型网关的地址（http://<网桥地址>:<端口>）。 */
export function modelsPatch(providers: readonly SandboxProvider[], gateway: string): string {
  const routes: Record<string, Record<string, unknown>> = {};
  const entries: Array<Record<string, unknown>> = [];
  for (const p of providers) {
    if (p.kind === "deepseek") {
      const models = p.models ?? [];
      if (models.some((m) => !DEEPSEEK_BUILTIN.has(m.id))) {
        entries.push({
          id: "llm-deepseek",
          config: {
            models: models.map((m) => ({
              id: m.id,
              ...(m.name ? { name: m.name } : {}),
              ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
              ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
              inputModalities: m.input?.length ? m.input : ["text"],
            })),
          },
        });
      }
      continue;
    }
    routes[p.id] = {
      apiKeyEnv: MODEL_KEY_ENV,
      displayName: p.name,
      baseURL: `${gateway.replace(/\/+$/, "")}/v1/providers/${p.id}`,
      ...(p.kind === "custom" && p.api ? { api: p.api } : {}),
      // 目录里的模型的推理等级由目录给（和 dsh 的模型页一样，表单里不改）
      ...(p.models ? { models: p.models.map((m) => piModel(m, p.kind === "custom")) } : {}),
    };
  }
  entries.unshift({ id: "llm-pi-ai", config: { providers: routes } });
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/** 配置变了没有（宿主机按它决定要不要重启 dsh）。 */
export function modelsVersion(providers: readonly SandboxProvider[] | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(providers ?? []))
    .digest("hex")
    .slice(0, 16);
}

/**
 * 一个回合在 dsh 里用哪个路由，要不要带思考强度：DeepSeek 是 deepseek-official；别的提供方的路由名就是 Provider ID。
 * 自定义接口的模型没声明推理等级时不带思考强度（dsh 里这种模型没有推理等级，由接口自己的默认值决定）。
 */
export function dshRoute(
  providers: readonly SandboxProvider[] | undefined,
  provider: string | undefined,
  model: string,
): { route: string; reasoning: boolean } {
  if (!provider || provider === "deepseek") return { route: DEEPSEEK_ROUTE, reasoning: true };
  const p = providers?.find((x) => x.id === provider);
  if (p?.kind === "custom") {
    const m = p.models?.find((x) => x.id === model);
    return { route: provider, reasoning: Boolean(m?.reasoningEfforts) };
  }
  return { route: provider, reasoning: true };
}
