import { MODEL_PROTOCOLS, type ModelProtocol } from "@seekcloud/protocol";
import { useState } from "react";
import { type ApiError, api } from "../../api";
import { shortDateTime } from "../../session/relative-time";
import { KeyField } from "./KeyField";
import { type DraftModel, draftOf, ModelEditor } from "./ModelEditor";
import {
  type KeyDraft,
  keyPatch,
  MODEL_PROVIDERS,
  PROTOCOL_LABELS,
  type ProviderView,
  specOf,
} from "./types";
import { urlWarnings } from "./url-check";

const KIND_LABELS: Record<ProviderView["kind"], string> = {
  deepseek: "内置",
  catalog: "第三方",
  custom: "自定义",
};

/** 卡片上一行的状态：用的是哪把 key。 */
export function credentialLine(p: ProviderView): string {
  if (p.credential.masked) return `已保存密钥 ${p.credential.masked}`;
  if (p.credential.envDetected) return `使用环境变量 ${p.credential.envDetected}`;
  return p.credential.env.length > 0
    ? `未设置密钥，也未检测到 ${p.credential.env.join("、")}`
    : "未设置密钥";
}

/**
 * 一个模型提供方的卡片（照 dsh 的模型页）：名称、状态、启用开关；编辑时是显示名称、API 密钥、地址、协议，
 * 以及"自定义设置"里的模型目录（内置的、目录里的改了就用自己的列表，"恢复默认模型"退回去）。
 */
export function ProviderCard({
  provider,
  onSaved,
  onDeleted,
}: {
  provider: ProviderView;
  onSaved: (next: ProviderView) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setError(undefined);
    try {
      onSaved(
        await api<ProviderView>(
          `${MODEL_PROVIDERS}/${provider.id}`,
          { enabled: !provider.enabled },
          "PATCH",
        ),
      );
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  return (
    <div className={`settings-card provider-card${provider.enabled ? "" : " disabled"}`}>
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">
            {provider.name}
            <span className="provider-kind">{KIND_LABELS[provider.kind]}</span>
          </span>
          <span className="settings-row-sub">
            {provider.enabled ? credentialLine(provider) : "已停用"}
            {provider.kind === "custom" && provider.api && ` · ${PROTOCOL_LABELS[provider.api]}`}
            {` · ${provider.models.length} 个模型`}
          </span>
        </span>
        <span className="settings-actions">
          {!editing && (
            <button type="button" className="pill-button" onClick={() => setEditing(true)}>
              编辑
            </button>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={provider.enabled}
            aria-label={`启用 ${provider.name}`}
            className="switch"
            disabled={busy}
            onClick={() => void toggle()}
          >
            <span className="switch-knob" aria-hidden="true" />
          </button>
        </span>
      </div>
      {provider.keyRejectedAt && !editing && (
        <p className="alert" role="alert">
          模型服务于 {shortDateTime(new Date(provider.keyRejectedAt))}{" "}
          拒绝了当前的密钥，请检查它是否正确、是否已失效或余额不足，必要时替换。
        </p>
      )}
      {editing && (
        <ProviderForm
          provider={provider}
          busy={busy}
          setBusy={setBusy}
          onCancel={() => {
            setEditing(false);
            setError(undefined);
          }}
          onSaved={(next) => {
            onSaved(next);
            setEditing(false);
          }}
          onDeleted={onDeleted}
        />
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ProviderForm({
  provider,
  busy,
  setBusy,
  onCancel,
  onSaved,
  onDeleted,
}: {
  provider: ProviderView;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: (next: ProviderView) => void;
  onDeleted: () => void;
}) {
  const custom = provider.kind === "custom";
  const [name, setName] = useState(provider.name);
  const [key, setKey] = useState<KeyDraft>({ kind: "keep" });
  const [apiKeyEnv, setApiKeyEnv] = useState(provider.credential.apiKeyEnv ?? "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(provider.api ?? "openai-completions");
  // 自定义设置（模型目录）：自定义接口一直展开；内置的、目录里的点开才有
  const [advanced, setAdvanced] = useState(custom);
  const [models, setModels] = useState<DraftModel[]>();
  const [reset, setReset] = useState(false);
  const [warnings, setWarnings] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<number>();

  const shownModels = models ?? provider.models.map((m) => draftOf(specOf(m)));
  const env = custom ? (apiKeyEnv.trim() ? [apiKeyEnv.trim()] : []) : provider.credential.env;

  const save = async (confirmed = false) => {
    setError(undefined);
    const url = baseUrl.trim();
    if (custom && !url) return setError("请填写基础 URL");
    // 改了地址：不是 HTTPS、在内网时先提示，再点一次才保存
    if (!confirmed && url && url !== (provider.baseUrl ?? "")) {
      const found = await urlWarnings(url);
      if (found.length > 0) return setWarnings(found);
    }
    const patch: Record<string, unknown> = {};
    if (name.trim() !== provider.name) patch.name = name.trim();
    const apiKey = keyPatch(key);
    if (apiKey !== undefined) patch.apiKey = apiKey;
    if (custom && apiKeyEnv.trim() !== (provider.credential.apiKeyEnv ?? "")) {
      patch.apiKeyEnv = apiKeyEnv.trim() || null;
    }
    if (url !== (provider.baseUrl ?? "")) patch.baseUrl = url || null;
    if (custom && protocol !== provider.api) patch.api = protocol;
    if (reset) patch.resetModels = true;
    else if (models) {
      // 内置的、目录里的模型的推理等级由目录给（和 dsh 一样不在表单里改）
      patch.models = models.map(({ key: _key, ...spec }) =>
        custom ? spec : { ...spec, reasoningEfforts: null },
      );
    }
    setBusy(true);
    try {
      onSaved(await api<ProviderView>(`${MODEL_PROVIDERS}/${provider.id}`, patch, "PATCH"));
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
      setWarnings(undefined);
    }
  };

  const askDelete = async () => {
    setError(undefined);
    try {
      const { sessions } = await api<{ sessions: number }>(
        `${MODEL_PROVIDERS}/${provider.id}/sessions`,
      );
      setConfirmDelete(sessions);
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`${MODEL_PROVIDERS}/${provider.id}`, {}, "DELETE");
      onDeleted();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const probe = {
    id: provider.id,
    ...(custom ? { api: protocol } : {}),
    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(key.kind === "replace" && key.value.trim() ? { apiKey: key.value.trim() } : {}),
  };

  return (
    <form
      className="settings-form provider-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field">
        <span>显示名称</span>
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      {custom && <p className="settings-hint">Provider ID：{provider.id}（不能修改）</p>}
      <KeyField
        masked={provider.credential.masked}
        env={env}
        envDetected={provider.credential.envDetected}
        draft={key}
        onDraft={setKey}
      />
      {custom && (
        <label className="field">
          <span>环境变量名（可选）</span>
          <input
            value={apiKeyEnv}
            placeholder="MY_GATEWAY_API_KEY"
            maxLength={100}
            onChange={(e) => setApiKeyEnv(e.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>基础 URL</span>
        <input
          value={baseUrl}
          inputMode="url"
          maxLength={500}
          placeholder={provider.defaultBaseUrl ?? "https://gateway.example/v1"}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setWarnings(undefined);
          }}
        />
      </label>
      {custom && (
        <label className="field">
          <span>API 协议</span>
          <select
            className="settings-select"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as ModelProtocol)}
          >
            {MODEL_PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {PROTOCOL_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      )}
      {!custom && (
        <button
          type="button"
          className="link-button"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          自定义设置
        </button>
      )}
      {advanced && (
        <>
          {reset ? (
            <p className="settings-hint">保存后恢复默认的模型列表。</p>
          ) : (
            <ModelEditor
              models={shownModels}
              onChange={setModels}
              probe={probe}
              allowReasoning={custom}
            />
          )}
          {!custom && (provider.customModels || models) && !reset && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setReset(true);
                setModels(undefined);
              }}
            >
              恢复默认模型
            </button>
          )}
          {provider.kind === "deepseek" && !provider.customModels && !models && (
            <p className="settings-hint">
              使用 DeepSeek 发布的模型列表时，这里显示内置的模型；新发布的模型只出现在模型选择器中。
            </p>
          )}
        </>
      )}
      {warnings && (
        <div className="alert" role="alert">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <p>确认无误后再次点击“保存”。</p>
        </div>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {confirmDelete !== undefined && (
        <div className="alert" role="alert">
          <p>
            删除后，它的密钥和模型列表一并删除。
            {confirmDelete > 0
              ? `有 ${confirmDelete} 个会话正在使用它的模型，这些会话下次发消息时需要换一个模型。`
              : ""}
          </p>
        </div>
      )}
      <div className="settings-form-actions spread">
        {provider.kind !== "deepseek" &&
          (confirmDelete === undefined ? (
            <button type="button" className="pill-button danger" onClick={() => void askDelete()}>
              删除
            </button>
          ) : (
            <button
              type="button"
              className="pill-button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              确认删除
            </button>
          ))}
        <span className="settings-form-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            取消
          </button>
          <button
            type={warnings ? "button" : "submit"}
            className="primary"
            disabled={busy}
            onClick={warnings ? () => void save(true) : undefined}
          >
            {busy ? "请稍候…" : "保存"}
          </button>
        </span>
      </div>
    </form>
  );
}
