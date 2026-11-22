import { type ApiError, api } from "../api";
import { setCached, useCached } from "../cached";
import { SparkIcon } from "../Icons";
import { reloadModels } from "../session/useModels";
import { Select, type SelectOption } from "../ui/select";
import { toast, useErrorToast } from "../ui/toast";
import { AddProvider } from "./models/AddProvider";
import { ProviderCard } from "./models/ProviderCard";
import { costText } from "./models/tokens";
import { MODEL_PROVIDERS, type ProviderView } from "./models/types";

export { MODEL_PROVIDERS } from "./models/types";
export const PLATFORM_MODEL = "/api/settings/platform-model";

/**
 * 设置里的"模型"一类（照 dsh 的"设置 → 模型"，#113）：内置的 DeepSeek 和加进来的提供方，一个一张卡片，
 * 下面是"添加模型提供商"；最后是平台调用的模型（#140）。改动下一次请求就生效，不用重启沙箱。
 */
export function ModelSettings() {
  const loaded = useCached<{ providers: ProviderView[] }>(MODEL_PROVIDERS);
  const providers = loaded.data?.providers;
  useErrorToast(loaded.error);
  const write = (next: ProviderView[]) => {
    setCached(MODEL_PROVIDERS, { providers: next });
    reloadModels();
    // 提供方、模型、价格变了，"自动"挑的可能也跟着变
    api<PlatformState>(PLATFORM_MODEL).then(
      (state) => setCached(PLATFORM_MODEL, state),
      () => undefined,
    );
  };
  return (
    <>
      <section className="settings-section">
        <h2>模型服务</h2>
        <p className="settings-hint">
          密钥只保存在主站，加密存放，不会进入沙箱，Agent 无法读取。修改在下一次请求时生效。
        </p>
        {providers?.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            onSaved={(next) => write(providers.map((x) => (x.id === next.id ? next : x)))}
            onDeleted={() => write(providers.filter((x) => x.id !== p.id))}
          />
        ))}
        {providers && <AddProvider onAdded={(p) => write([...providers, p])} />}
      </section>
      <PlatformModel />
    </>
  );
}

/** 平台调用的模型（GET /api/settings/platform-model）。 */
interface PlatformState {
  model: string;
  /** 现在实际用的模型；一个能用的都没有时为空。 */
  resolved: string | null;
  basis: "chosen" | "price" | "order" | "none";
  candidates: Array<{
    ref: string;
    name: string;
    providerName: string;
    cost: [number, number] | null;
    /** 估一次平台调用的价钱（美元）。 */
    callCost: number | null;
    canSkipThinking: boolean;
  }>;
}

/** 一次平台调用大约多少钱。 */
function perCall(usd: number): string {
  if (usd < 0.0001) return "每次不到 $0.0001";
  return `每次约 $${Number(usd.toPrecision(2))}`;
}

/**
 * 平台自己发起的模型调用（判断会话是否在等你输入、生成置顶消息的短标题）用哪个模型。
 * 2026-11-22 用户问"怎么知道哪个模型最省"：每个模型旁边写出价格和估出来的一次调用的价钱，
 * "自动"写明现在用的是哪个、为什么；关不掉思考的模型标出来（平台调用不思考）。点了当场保存。
 */
function PlatformModel() {
  const loaded = useCached<PlatformState>(PLATFORM_MODEL);
  const state = loaded.data;
  useErrorToast(loaded.error);

  const choose = async (next: string) => {
    if (!state || next === state.model) return;
    setCached(PLATFORM_MODEL, { ...state, model: next });
    try {
      setCached(PLATFORM_MODEL, await api<PlatformState>(PLATFORM_MODEL, { model: next }, "PUT"));
    } catch (e) {
      setCached(PLATFORM_MODEL, state);
      toast((e as ApiError).message, "error");
    }
  };

  const resolved = state?.candidates.find((c) => c.ref === state.resolved);
  const autoHint =
    state?.basis === "none"
      ? "目前没有可用的模型"
      : state?.model !== "auto" || !resolved
        ? "按价格选最省的模型"
        : state.basis === "price"
          ? `现在是 ${resolved.name}：按价格估算最省`
          : `现在是 ${resolved.name}：都没有价格，按列表顺序选第一个`;
  const options: SelectOption[] = [
    { value: "auto", label: "自动", hint: autoHint },
    ...(state?.candidates ?? []).map((c) => ({
      value: c.ref,
      label: c.name,
      group: c.providerName,
      hint: [
        c.cost ? costText(c.cost) : "没有价格",
        c.callCost !== null ? perCall(c.callCost) : undefined,
        c.canSkipThinking ? undefined : "无法关闭思考",
      ]
        .filter(Boolean)
        .join(" · "),
    })),
  ];
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <SparkIcon size={16} />
        <h2>平台调用的模型</h2>
      </div>
      <Select
        label="平台调用的模型"
        value={state?.model ?? "auto"}
        options={options}
        disabled={!state}
        onChange={(v) => void choose(v)}
      />
      {state?.model === "auto" && resolved && (
        <p className="platform-resolved">
          现在使用 <strong>{resolved.name}</strong>
          {resolved.cost
            ? `（${costText(resolved.cost)}，${perCall(resolved.callCost ?? 0)}）`
            : ""}
        </p>
      )}
      <p className="settings-group-hint">
        回合结束后判断会话是否在等待你的输入、生成置顶消息的短标题时，会调用一次模型（不开启思考），用量照常记录。
      </p>
      <p className="settings-group-hint">
        选“自动”时，在能关闭思考的模型中，按价格估算一次调用（约 2,000 个输入 token、20 个输出
        token）的花费，选最省的。价格来自 dsh 内置的模型目录（美元 / 百万
        token），可能与提供方的现行价格不同；自定义接口的模型填写价格后才参与比较。
      </p>
    </section>
  );
}
