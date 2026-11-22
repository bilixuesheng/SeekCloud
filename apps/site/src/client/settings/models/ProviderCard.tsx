import { MODEL_PROTOCOLS, type ModelProtocol } from "@seekcloud/protocol";
import { useState } from "react";
import { type ApiError, api } from "../../api";
import { shortDateTime } from "../../i18n/format";
import { confirmDialog } from "../../ui/confirm";
import { Modal } from "../../ui/modal";
import { Select } from "../../ui/select";
import { toast } from "../../ui/toast";
import { KeyField } from "./KeyField";
import { type DraftModel, draftOf, fitDrafts, ModelEditor, specOfDraft } from "./ModelEditor";
import {
  type KeyDraft,
  keyPatch,
  MODEL_PROVIDERS,
  PROTOCOL_LABELS,
  type ProviderView,
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

/** 卡片上最多直接列出几个模型，多的写"还有 N 个"。 */
const CHIPS = 8;

/**
 * 一个模型提供方的卡片（照 dsh 的模型页，2026-11-22 用户要求做得比 dsh 更顺手）：名称、用的是哪把 key、
 * 启用开关，下面直接列出它的模型。"管理模型"打开模型目录（手动添加、获取可用模型、调整顺序、模型选项），
 * "连接设置"改名称、密钥、地址和协议，都在弹窗里做；删除先弹窗确认。
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
  const [dialog, setDialog] = useState<"models" | "connection">();
  const [busy, setBusy] = useState(false);
  const close = () => setDialog(undefined);

  const toggle = async () => {
    setBusy(true);
    try {
      const next = await api<ProviderView>(
        `${MODEL_PROVIDERS}/${provider.id}`,
        { enabled: !provider.enabled },
        "PATCH",
      );
      onSaved(next);
      toast(next.enabled ? `已启用 ${provider.name}。` : `已停用 ${provider.name}。`);
    } catch (e) {
      toast((e as ApiError).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    let sessions = 0;
    try {
      ({ sessions } = await api<{ sessions: number }>(
        `${MODEL_PROVIDERS}/${provider.id}/sessions`,
      ));
    } catch (e) {
      toast((e as ApiError).message, "error");
      return;
    }
    const ok = await confirmDialog({
      title: `删除“${provider.name}”？`,
      body: (
        <>
          <p>它的密钥和模型列表将一并删除，无法恢复。</p>
          {sessions > 0 && (
            <p>有 {sessions} 个会话正在使用它的模型，这些会话下次发消息时需要换一个模型。</p>
          )}
        </>
      ),
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`${MODEL_PROVIDERS}/${provider.id}`, {}, "DELETE");
      onDeleted();
      toast(`已删除 ${provider.name}。`);
    } catch (e) {
      toast((e as ApiError).message, "error");
    }
  };

  const models = provider.models;
  return (
    <div className={`settings-card provider-card${provider.enabled ? "" : " disabled"}`}>
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">
            {provider.name}
            <span className="provider-kind">{KIND_LABELS[provider.kind]}</span>
          </span>
          <span className="settings-row-sub provider-status">
            {provider.enabled ? credentialLine(provider) : "已停用"}
            {provider.kind === "custom" && provider.api && ` · ${PROTOCOL_LABELS[provider.api]}`}
          </span>
        </span>
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
      </div>
      {provider.keyRejectedAt && (
        <p className="alert" role="alert">
          模型服务于 {shortDateTime(new Date(provider.keyRejectedAt))}{" "}
          拒绝了当前的密钥，请检查它是否正确、是否已失效或余额不足，必要时在“连接设置”中替换。
        </p>
      )}
      <div className="model-chips">
        {models.length === 0 ? (
          <span className="settings-row-sub">还没有模型，请在“管理模型”中添加。</span>
        ) : (
          <>
            {models.slice(0, CHIPS).map((m) => (
              <span key={m.id} className="model-chip" title={m.id}>
                {m.name}
              </span>
            ))}
            {models.length > CHIPS && (
              <button type="button" className="model-chip more" onClick={() => setDialog("models")}>
                还有 {models.length - CHIPS} 个
              </button>
            )}
          </>
        )}
      </div>
      <div className="provider-actions">
        <button type="button" className="pill-button accent" onClick={() => setDialog("models")}>
          管理模型
        </button>
        <button type="button" className="pill-button" onClick={() => setDialog("connection")}>
          连接设置
        </button>
        {provider.kind !== "deepseek" && (
          <button type="button" className="pill-button danger-text" onClick={() => void remove()}>
            删除
          </button>
        )}
      </div>

      <Modal open={dialog === "models"} wide title={`${provider.name} 的模型`} onClose={close}>
        <ModelsForm
          provider={provider}
          onCancel={close}
          onSaved={(next) => {
            onSaved(next);
            close();
          }}
        />
      </Modal>
      <Modal open={dialog === "connection"} title={`${provider.name} 的连接设置`} onClose={close}>
        <ConnectionForm
          provider={provider}
          onCancel={close}
          onSaved={(next) => {
            onSaved(next);
            close();
          }}
        />
      </Modal>
    </div>
  );
}

/**
 * 模型目录（弹窗里）：手动添加、获取可用模型、拖动排序、每个模型的选项。内置的、目录里的改了就用自己的列表，
 * "恢复默认模型"退回目录给的（和 dsh 一样）。
 */
function ModelsForm({
  provider,
  onCancel,
  onSaved,
}: {
  provider: ProviderView;
  onCancel: () => void;
  onSaved: (next: ProviderView) => void;
}) {
  const custom = provider.kind === "custom";
  const [models, setModels] = useState<DraftModel[]>(() =>
    provider.models.map((m) => draftOf(m, provider.kind)),
  );
  const [busy, setBusy] = useState(false);

  const patch = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      onSaved(await api<ProviderView>(`${MODEL_PROVIDERS}/${provider.id}`, body, "PATCH"));
      toast(done);
    } catch (e) {
      toast((e as ApiError).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    patch({ models: models.map((m) => specOfDraft(m, provider.kind)) }, "模型列表已保存。");

  const reset = async () => {
    const ok = await confirmDialog({
      title: "恢复默认的模型列表？",
      body: "将改回目录提供的模型和顺序，你添加和修改过的模型会被移除。",
      confirmText: "恢复默认",
    });
    if (ok) await patch({ resetModels: true }, "已恢复默认的模型列表。");
  };

  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {provider.kind === "deepseek" && !provider.customModels && (
        <p className="settings-hint">
          使用 DeepSeek 发布的模型列表时，这里显示内置的模型；新发布的模型会自动出现在模型选择器中。
        </p>
      )}
      <ModelEditor
        models={models}
        onChange={setModels}
        context={{
          kind: provider.kind,
          providerId: provider.id,
          protocol: provider.api ?? "openai-completions",
          probe: { id: provider.id },
          efforts: provider.models[0]?.efforts,
        }}
      />
      <div className="settings-form-actions spread">
        {!custom && provider.customModels ? (
          <button
            type="button"
            className="pill-button"
            disabled={busy}
            onClick={() => void reset()}
          >
            恢复默认模型
          </button>
        ) : (
          <span />
        )}
        <span className="settings-form-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            取消
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || (custom && models.length === 0)}
          >
            {busy ? "请稍候…" : "保存"}
          </button>
        </span>
      </div>
    </form>
  );
}

/** 连接设置（弹窗里）：显示名称、API 密钥、地址；自定义接口还有环境变量名和协议。 */
function ConnectionForm({
  provider,
  onCancel,
  onSaved,
}: {
  provider: ProviderView;
  onCancel: () => void;
  onSaved: (next: ProviderView) => void;
}) {
  const custom = provider.kind === "custom";
  const [name, setName] = useState(provider.name);
  const [key, setKey] = useState<KeyDraft>({ kind: "keep" });
  const [apiKeyEnv, setApiKeyEnv] = useState(provider.credential.apiKeyEnv ?? "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(provider.api ?? "openai-completions");
  const [busy, setBusy] = useState(false);
  const env = custom ? (apiKeyEnv.trim() ? [apiKeyEnv.trim()] : []) : provider.credential.env;

  const save = async () => {
    const url = baseUrl.trim();
    if (custom && !url) return toast("请填写基础 URL", "error");
    // 改了地址：不是 HTTPS、在内网时先确认
    if (url && url !== (provider.baseUrl ?? "")) {
      const found = await urlWarnings(url);
      if (
        found.length > 0 &&
        !(await confirmDialog({
          title: "确认使用这个地址？",
          body: (
            <>
              {found.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </>
          ),
          confirmText: "仍然保存",
        }))
      ) {
        return;
      }
    }
    const patch: Record<string, unknown> = {};
    if (name.trim() !== provider.name) patch.name = name.trim();
    const apiKey = keyPatch(key);
    if (apiKey !== undefined) patch.apiKey = apiKey;
    if (custom && apiKeyEnv.trim() !== (provider.credential.apiKeyEnv ?? "")) {
      patch.apiKeyEnv = apiKeyEnv.trim() || null;
    }
    if (url !== (provider.baseUrl ?? "")) patch.baseUrl = url || null;
    let refitted = 0;
    if (custom && protocol !== provider.api) {
      patch.api = protocol;
      // 换协议时已有模型的思考档位跟着调整（比如换成 Gemini 时去掉"关闭"），不然保存不了
      const before = provider.models.map((m) => draftOf(m, "custom"));
      const after = fitDrafts(before, protocol);
      refitted = after.filter(
        (m, i) =>
          JSON.stringify(m.reasoningEfforts) !== JSON.stringify(before[i]?.reasoningEfforts),
      ).length;
      if (refitted > 0) patch.models = after.map((m) => specOfDraft(m, "custom"));
    }
    if (Object.keys(patch).length === 0) return onCancel();
    setBusy(true);
    try {
      onSaved(await api<ProviderView>(`${MODEL_PROVIDERS}/${provider.id}`, patch, "PATCH"));
      toast(
        refitted > 0
          ? `连接设置已保存；按 ${PROTOCOL_LABELS[protocol]} 调整了 ${refitted} 个模型的思考档位。`
          : "连接设置已保存，下一次请求时生效。",
      );
    } catch (e) {
      toast((e as ApiError).message, "error");
    } finally {
      setBusy(false);
    }
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
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      {!custom && (
        <p className="settings-hint">
          留空时使用默认地址{provider.defaultBaseUrl ? `（${provider.defaultBaseUrl}）` : ""}。
        </p>
      )}
      {custom && (
        <div className="field">
          <span>API 协议</span>
          <Select
            label="API 协议"
            value={protocol}
            options={MODEL_PROTOCOLS.map((p) => ({ value: p, label: PROTOCOL_LABELS[p] }))}
            onChange={(v) => setProtocol(v as ModelProtocol)}
          />
        </div>
      )}
      <div className="settings-form-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "请稍候…" : "保存"}
        </button>
      </div>
    </form>
  );
}
