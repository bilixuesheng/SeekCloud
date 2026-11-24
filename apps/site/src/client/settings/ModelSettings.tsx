import { type ApiError, api } from "../api";
import { setCached, useCached } from "../cached";
import { t, tRich, useT } from "../i18n";
import { errorText } from "../i18n/errors";
import { reloadModels } from "../session/useModels";
import { Select, type SelectOption } from "../ui/select";
import { toast, useErrorToast } from "../ui/toast";
import { AddProvider } from "./models/AddProvider";
import { ProviderCard } from "./models/ProviderCard";
import { costText } from "./models/tokens";
import { MODEL_PROVIDERS, type ProviderView, providerLabel } from "./models/types";

export { MODEL_PROVIDERS } from "./models/types";
export const PLATFORM_MODEL = "/api/settings/platform-model";

/**
 * 设置里的"模型"一类（照 dsh 的"设置 → 模型"，#113）：内置的 DeepSeek 和加进来的提供方，一个一张卡片，
 * 下面是"添加模型提供商"；最后是平台调用的模型（#140）。改动下一次请求就生效，不用重启沙箱。
 */
export function ModelSettings() {
  const t = useT();
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
        <h2>{t("models.service")}</h2>
        <p className="settings-hint">{t("models.serviceHint")}</p>
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
  if (usd < 0.0001) return t("models.perCallTiny");
  return t("models.perCall", { amount: `$${Number(usd.toPrecision(2))}` });
}

/**
 * 平台自己发起的模型调用（判断会话是否在等你输入、生成置顶消息的短标题）用哪个模型。
 * 2026-11-22 用户问"怎么知道哪个模型最省"：每个模型旁边写出价格和估出来的一次调用的价钱，
 * "自动"写明现在用的是哪个、为什么；关不掉思考的模型标出来（平台调用不思考）。点了当场保存。
 */
function PlatformModel() {
  const t = useT();
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
      toast(errorText(e as ApiError), "error");
    }
  };

  const resolved = state?.candidates.find((c) => c.ref === state.resolved);
  const autoHint =
    state?.basis === "none"
      ? t("models.noAvailable")
      : state?.model !== "auto" || !resolved
        ? t("models.autoCheapest")
        : state.basis === "price"
          ? t("models.autoNowPrice", { name: resolved.name })
          : t("models.autoNowOrder", { name: resolved.name });
  const options: SelectOption[] = [
    { value: "auto", label: t("models.auto"), hint: autoHint },
    ...(state?.candidates ?? []).map((c) => ({
      value: c.ref,
      label: c.name,
      group: providerLabel(c.ref.split("/")[0] ?? "", c.providerName),
      hint: [
        c.cost ? costText(c.cost) : t("models.noPrice"),
        c.callCost !== null ? perCall(c.callCost) : undefined,
        c.canSkipThinking ? undefined : t("models.alwaysThinks"),
      ]
        .filter(Boolean)
        .join(" · "),
    })),
  ];
  return (
    <section className="settings-section settings-group">
      <h2>{t("models.platform")}</h2>
      <Select
        label={t("models.platform")}
        value={state?.model ?? "auto"}
        options={options}
        disabled={!state}
        onChange={(v) => void choose(v)}
      />
      {state?.model === "auto" && resolved && (
        <p className="platform-resolved">
          {tRich("models.platformNow", { name: <strong>{resolved.name}</strong> })}
          {resolved.cost
            ? t("models.platformCost", {
                cost: costText(resolved.cost),
                perCall: perCall(resolved.callCost ?? 0),
              })
            : ""}
        </p>
      )}
      <p className="settings-group-hint">{t("models.platformHint")}</p>
      <p className="settings-group-hint">{t("models.platformAutoHint")}</p>
    </section>
  );
}
