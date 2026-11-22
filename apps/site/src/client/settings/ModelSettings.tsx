import { type FormEvent, useState } from "react";
import { type ApiError, api } from "../api";
import { setCached, useCached } from "../cached";
import { SparkIcon } from "../Icons";
import { shortDateTime } from "../session/relative-time";
import { reloadModels, useModels } from "../session/useModels";

export const MODEL_PROVIDERS = "/api/settings/model-providers";
export const PLATFORM_MODEL = "/api/settings/platform-model";

/** 设置接口里的一个提供方（server/routes/model.ts 的 ModelProvider）。 */
export interface ProviderView {
  id: string;
  name: string;
  kind: "deepseek" | "catalog" | "custom";
  enabled: boolean;
  credential: {
    masked: string | null;
    env: string[];
    envDetected: string | null;
    apiKeyEnv: string | null;
  };
  keySetAt: string | null;
  keyRejectedAt: string | null;
}

/** 设置里的"模型"一类：模型服务的 API key（#26），平台自己发起的调用用哪个模型（#140）。 */
export function ModelSettings() {
  return (
    <>
      <section className="settings-section">
        <h2>模型服务</h2>
        <ApiKeyRow />
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

/** DeepSeek API key：加密存放，保存以后只显示脱敏预览。可以替换或删除（删除后读环境变量）。 */
function ApiKeyRow() {
  const loaded = useCached<{ providers: ProviderView[] }>(MODEL_PROVIDERS);
  const status = loaded.data?.providers.find((p) => p.kind === "deepseek");
  const keySet = Boolean(status?.credential.masked);
  const update = async (body: { apiKey: string | null }) => {
    const next = await api<ProviderView>(`${MODEL_PROVIDERS}/deepseek`, body, "PATCH");
    setCached(MODEL_PROVIDERS, {
      providers: (loaded.data?.providers ?? []).map((p) => (p.id === next.id ? next : p)),
    });
    reloadModels();
  };
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setError] = useState<string>();
  const error = failed ?? loaded.error;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await update({ apiKey: draft.trim() });
      setDraft("");
      setEditing(false);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await update({ apiKey: null });
      setConfirmDelete(false);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">{status?.name ?? "DeepSeek 官方"} API key</span>
          <span className="settings-row-sub">
            {status === undefined
              ? "　"
              : keySet
                ? `${status.credential.masked}${status.keySetAt ? `，保存于 ${shortDateTime(new Date(status.keySetAt))}` : ""}。加密存放，不再显示原文。`
                : status.credential.envDetected
                  ? `未保存，使用环境变量 ${status.credential.envDetected}。`
                  : "未设置。设置之前无法使用 DeepSeek 的模型。"}
          </span>
        </span>
        {status && !editing && !confirmDelete && (
          <span className="settings-actions">
            {keySet && (
              <button type="button" className="pill-button" onClick={() => setConfirmDelete(true)}>
                删除
              </button>
            )}
            <button
              type="button"
              className="pill-button"
              onClick={() => {
                setEditing(true);
                setError(undefined);
              }}
            >
              {keySet ? "替换" : "设置"}
            </button>
          </span>
        )}
        {confirmDelete && (
          <span className="settings-actions">
            <button type="button" className="pill-button" onClick={() => setConfirmDelete(false)}>
              取消
            </button>
            <button
              type="button"
              className="pill-button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              确认删除
            </button>
          </span>
        )}
      </div>
      {status?.keyRejectedAt && !editing && (
        <p className="alert" role="alert">
          模型服务于 {shortDateTime(new Date(status.keyRejectedAt))} 拒绝了这个
          key，请检查它是否正确、是否已失效或余额不足，必要时替换。
        </p>
      )}
      {confirmDelete && (
        <p className="settings-hint">
          {status?.credential.envDetected
            ? `删除以后改用环境变量 ${status.credential.envDetected}。`
            : "删除以后无法使用 DeepSeek 的模型，运行中的会话调用模型也会失败。"}
        </p>
      )}
      {editing && (
        <form className="settings-form" onSubmit={save}>
          <label className="field">
            <span>DeepSeek API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
              required
              maxLength={400}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <p className="settings-hint">
            在 DeepSeek 开放平台创建。key 只保存在主站，不会进入沙箱，Agent 无法读取。
          </p>
          <div className="settings-form-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
            >
              取消
            </button>
            <button type="submit" className="primary" disabled={busy || !draft.trim()}>
              {busy ? "请稍候…" : "保存"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
