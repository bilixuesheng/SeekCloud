import { useState } from "react";
import { type ApiError, api } from "../api";
import { setCached, useCached } from "../cached";
import { SparkIcon } from "../Icons";
import { reloadModels, useModels } from "../session/useModels";
import { AddProvider } from "./models/AddProvider";
import { ProviderCard } from "./models/ProviderCard";
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
  const write = (next: ProviderView[]) => {
    setCached(MODEL_PROVIDERS, { providers: next });
    reloadModels();
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
        {loaded.error && (
          <p className="alert" role="alert">
            {loaded.error}
          </p>
        )}
        {providers && <AddProvider onAdded={(p) => write([...providers, p])} />}
      </section>
      <PlatformModel />
    </>
  );
}

/**
 * 平台自己发起的模型调用（判断会话是否在等你输入这些）用哪个模型：自动（最省的）加上每个模型一排，
 * 点了当场保存，没存上就拨回去并说明原因。
 */
function PlatformModel() {
  const loaded = useCached<{ model: string }>(PLATFORM_MODEL);
  const models = useModels()?.models;
  const current = loaded.data?.model;
  const [failed, setError] = useState<string>();
  const error = failed ?? loaded.error;

  const choose = async (next: string) => {
    if (current === undefined || next === current) return;
    setCached(PLATFORM_MODEL, { model: next });
    setError(undefined);
    try {
      await api(PLATFORM_MODEL, { model: next }, "PUT");
    } catch (e) {
      setCached(PLATFORM_MODEL, { model: current });
      setError((e as ApiError).message);
    }
  };

  const choices = [
    { id: "auto", label: "自动" },
    ...(models ?? []).map((m) => ({
      id: m.id,
      label: m.provider === "deepseek" ? m.name : `${m.name}（${m.providerName}）`,
    })),
  ];
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <SparkIcon size={16} />
        <h2>平台调用的模型</h2>
      </div>
      {choices.length <= 4 ? (
        <fieldset className="segmented" disabled={current === undefined || !models}>
          <legend className="visually-hidden">平台调用的模型</legend>
          {choices.map((c) => (
            <label key={c.id} className={`segment${current === c.id ? " current" : ""}`}>
              <input
                type="radio"
                name="platform-model"
                value={c.id}
                checked={current === c.id}
                onChange={() => void choose(c.id)}
              />
              <span className="segment-label">{c.label}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        // 模型多了（加了别的提供方）：一排放不下，换成下拉框
        <select
          className="settings-select"
          aria-label="平台调用的模型"
          disabled={current === undefined || !models}
          value={current ?? "auto"}
          onChange={(e) => void choose(e.target.value)}
        >
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      <p className="settings-group-hint">
        回合结束后判断会话是否在等待你的输入时，会调用一次模型（不开启思考），用量照常记录。选择“自动”时使用能用的模型中最省的一个。
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
