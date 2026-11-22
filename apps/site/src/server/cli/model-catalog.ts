/**
 * 从装好的 @earendil-works/pi-ai（dsh 的第三方提供方目录，MIT）生成主站的目录快照
 * src/server/models/catalog.json。设置里"添加模型提供商 → 第三方模型提供商"列的就是它。
 *
 * 用法：在一个临时目录里 npm i @deepseek-ai/dsh@$(cat apps/host/sandbox/dsh/VERSION)，然后在 apps/site 里
 *   pnpm model-catalog <临时目录>/node_modules
 * 升级 dsh 时跟着重新生成一次（catalog.test.ts 核对快照记的 dsh 版本）。
 *
 * 只收填一个 key 就能用的：协议是四种之一（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、
 * Gemini）、地址是固定的（不带 {占位符}、不靠环境变量拼）、认证就是一个 API key。AWS、Vertex、Azure、
 * Cloudflare 这类要别的凭据，Copilot、Codex 要登录，DeepSeek 由内置的 DeepSeek 卡片管，都不收。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MODEL_PROTOCOLS, type ModelProtocol, THINKING_EFFORTS } from "@seekcloud/protocol";

const nodeModules = process.argv[2];
if (!nodeModules) {
  console.error("用法：pnpm model-catalog <装了 @deepseek-ai/dsh 的 node_modules>");
  process.exit(1);
}

const piAi = join(nodeModules, "@earendil-works/pi-ai");
const piAiVersion = JSON.parse(readFileSync(join(piAi, "package.json"), "utf8")).version as string;
const dshVersion = JSON.parse(
  readFileSync(join(nodeModules, "@deepseek-ai/dsh/package.json"), "utf8"),
).version as string;
const { findEnvKeys } = (await import(pathToFileURL(join(piAi, "dist/env-api-keys.js")).href)) as {
  findEnvKeys: (provider: string, env: Record<string, string>) => string[] | undefined;
};

/** 不收的提供方：认证不是一个 key，或者由内置的卡片管。 */
const SKIP = new Set([
  "deepseek",
  "github-copilot",
  "openai-codex",
  "amazon-bedrock",
  "google-vertex",
  "azure",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
]);

/** 常见提供方的显示名称；其余的用 ID（和 dsh 一样）。 */
const NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  moonshotai: "Kimi（Moonshot）",
  "moonshotai-cn": "Kimi（Moonshot 中国）",
  "kimi-coding": "Kimi Coding",
  zai: "智谱 GLM（Z.ai）",
  "zai-coding-cn": "智谱 GLM（中国）",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax（中国）",
  openrouter: "OpenRouter",
  groq: "Groq",
  xai: "xAI",
  together: "Together AI",
  fireworks: "Fireworks",
  huggingface: "Hugging Face",
  nvidia: "NVIDIA",
  cerebras: "Cerebras",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xiaomi: "小米 MiMo",
};

interface PiModel {
  id: string;
  name?: string;
  api: string;
  baseUrl?: string;
  type?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  cost?: { input?: number; output?: number };
  contextWindow?: number;
  maxTokens?: number;
}

/** pi-ai 的 getSupportedThinkingLevels：不推理的只有 off；映射成 null 的不给；xhigh、max 要写明才给。 */
function efforts(model: PiModel): string[] {
  if (!model.reasoning) return ["off"];
  return THINKING_EFFORTS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * 各档位发给接口的参数值里和档位名不一样的（比如 off 发 "none"）。和档位名一样的不记：设置页和 dsh 都默认用档位名。
 * 自定义接口添加一个认得出来的模型时，照这个填推理等级。
 */
function wire(model: PiModel, offered: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const level of offered) {
    const mapped = model.thinkingLevelMap?.[level];
    if (typeof mapped === "string" && mapped !== level) out[level] = mapped;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const isProtocol = (api: string): api is ModelProtocol =>
  (MODEL_PROTOCOLS as readonly string[]).includes(api);

const dataDir = join(piAi, "dist/providers/data");
const everyName = new Proxy({}, { get: () => "x", has: () => true }) as Record<string, string>;
const providers = [];
for (const file of readdirSync(dataDir).sort()) {
  if (!file.endsWith(".json") || file.startsWith(".")) continue;
  const id = file.slice(0, -".json".length);
  if (SKIP.has(id)) continue;
  const groups = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as Record<
    string,
    Record<string, PiModel>
  >;
  const endpoints: Partial<Record<ModelProtocol, string>> = {};
  const models = [];
  for (const model of Object.values(groups).flatMap((g) => Object.values(g))) {
    if (model.type !== "chat" || !isProtocol(model.api) || !model.baseUrl) continue;
    if (model.baseUrl.includes("{")) continue;
    const known = endpoints[model.api];
    if (known && known !== model.baseUrl) {
      throw new Error(`${id} 的 ${model.api} 有两个地址：${known}、${model.baseUrl}`);
    }
    endpoints[model.api] = model.baseUrl;
    const offered = efforts(model);
    const spelled = model.reasoning ? wire(model, offered) : undefined;
    models.push({
      id: model.id,
      name: model.name ?? model.id,
      api: model.api,
      input: model.input?.length ? model.input : ["text"],
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? null,
      efforts: offered,
      ...(spelled ? { wire: spelled } : {}),
      cost:
        model.cost?.input !== undefined && model.cost?.output !== undefined
          ? [model.cost.input, model.cost.output]
          : null,
    });
  }
  if (models.length === 0) continue;
  // anthropic 的 ANTHROPIC_AUTH_TOKEN、OAUTH_TOKEN 要放进 Authorization: Bearer，不是 key：只认 API key 那个。
  const env = (findEnvKeys(id, everyName) ?? []).filter(
    (name) => id !== "anthropic" || name === "ANTHROPIC_API_KEY",
  );
  providers.push({ id, name: NAMES[id] ?? id, env, endpoints, models });
}

const out = join(dirname(import.meta.dirname), "models/catalog.json");
writeFileSync(
  out,
  `${JSON.stringify({ source: { piAi: piAiVersion, dsh: dshVersion }, providers })}\n`,
);
console.log(
  `写好了 ${out}：${providers.length} 个提供方，${providers.reduce((n, p) => n + p.models.length, 0)} 个模型（pi-ai ${piAiVersion}，dsh ${dshVersion}）`,
);
