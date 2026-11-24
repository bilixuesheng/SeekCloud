import { MODEL_PROTOCOLS, type ModelProtocol } from "@seekcloud/protocol";
import { useState } from "react";
import { type ApiError, api } from "../../api";
import { type PlainKey, t, useT } from "../../i18n";
import { errorText } from "../../i18n/errors";
import { joinAlternatives, shortDateTime } from "../../i18n/format";
import { confirmDialog } from "../../ui/confirm";
import { Modal } from "../../ui/modal";
import { Select } from "../../ui/select";
import { toast } from "../../ui/toast";
import { KeyField } from "./KeyField";
import { type DraftModel, draftOf, fitDrafts, ModelEditor, specOfDraft } from "./ModelEditor";
import {
  isDefaultName,
  type KeyDraft,
  keyPatch,
  MODEL_PROVIDERS,
  PROTOCOL_LABELS,
  type ProviderView,
  providerLabel,
} from "./types";
import { urlWarnings } from "./url-check";

const KIND_LABELS: Record<ProviderView["kind"], PlainKey> = {
  deepseek: "models.kindDeepseek",
  catalog: "models.kindCatalog",
  custom: "models.kindCustom",
};

/** 卡片上一行的状态：用的是哪把 key。 */
export function credentialLine(p: ProviderView): string {
  if (p.credential.masked) return t("models.keySaved", { masked: p.credential.masked });
  if (p.credential.envDetected) return t("models.keyEnv", { env: p.credential.envDetected });
  return p.credential.env.length > 0
    ? t("models.keyMissingEnv", { env: joinAlternatives(p.credential.env) })
    : t("models.keyMissing");
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
  const t = useT();
  const [dialog, setDialog] = useState<"models" | "connection">();
  const [busy, setBusy] = useState(false);
  const close = () => setDialog(undefined);
  const name = providerLabel(provider.id, provider.name);

  const toggle = async () => {
    setBusy(true);
    try {
      const next = await api<ProviderView>(
        `${MODEL_PROVIDERS}/${provider.id}`,
        { enabled: !provider.enabled },
        "PATCH",
      );
      onSaved(next);
      toast(
        next.enabled ? t("models.enabledToast", { name }) : t("models.disabledToast", { name }),
      );
    } catch (e) {
      toast(errorText(e as ApiError), "error");
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
      toast(errorText(e as ApiError), "error");
      return;
    }
    const ok = await confirmDialog({
      title: t("models.deleteTitle", { name }),
      body: (
        <>
          <p>{t("models.deleteBody")}</p>
          {sessions > 0 && <p>{t("models.deleteSessions", { count: sessions })}</p>}
        </>
      ),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`${MODEL_PROVIDERS}/${provider.id}`, {}, "DELETE");
      onDeleted();
      toast(t("models.deleted", { name }));
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    }
  };

  const models = provider.models;
  return (
    <div className={`settings-card provider-card${provider.enabled ? "" : " disabled"}`}>
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">
            {name}
            <span className="provider-kind">{t(KIND_LABELS[provider.kind])}</span>
          </span>
          <span className="settings-row-sub provider-status">
            {provider.enabled ? credentialLine(provider) : t("models.disabled")}
            {provider.kind === "custom" && provider.api && ` · ${PROTOCOL_LABELS[provider.api]}`}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={provider.enabled}
          aria-label={t("models.enable", { name })}
          className="switch"
          disabled={busy}
          onClick={() => void toggle()}
        >
          <span className="switch-knob" aria-hidden="true" />
        </button>
      </div>
      {provider.keyRejectedAt && (
        <p className="alert" role="alert">
          {t("models.keyRejected", { time: shortDateTime(new Date(provider.keyRejectedAt)) })}
        </p>
      )}
      <div className="model-chips">
        {models.length === 0 ? (
          <span className="settings-row-sub">{t("models.noModelsYet")}</span>
        ) : (
          <>
            {models.slice(0, CHIPS).map((m) => (
              <span key={m.id} className="model-chip" title={m.id}>
                {m.name}
              </span>
            ))}
            {models.length > CHIPS && (
              <button type="button" className="model-chip more" onClick={() => setDialog("models")}>
                {t("models.more", { count: models.length - CHIPS })}
              </button>
            )}
          </>
        )}
      </div>
      <div className="provider-actions">
        <button type="button" className="pill-button accent" onClick={() => setDialog("models")}>
          {t("models.manage")}
        </button>
        <button type="button" className="pill-button" onClick={() => setDialog("connection")}>
          {t("models.connection")}
        </button>
        {provider.kind !== "deepseek" && (
          <button type="button" className="pill-button danger-text" onClick={() => void remove()}>
            {t("common.delete")}
          </button>
        )}
      </div>

      <Modal open={dialog === "models"} wide title={t("models.modelsOf", { name })} onClose={close}>
        <ModelsForm
          provider={provider}
          onCancel={close}
          onSaved={(next) => {
            onSaved(next);
            close();
          }}
        />
      </Modal>
      <Modal
        open={dialog === "connection"}
        title={t("models.connectionOf", { name })}
        onClose={close}
      >
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
  const t = useT();
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
      toast(errorText(e as ApiError), "error");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    patch({ models: models.map((m) => specOfDraft(m, provider.kind)) }, t("models.listSaved"));

  const reset = async () => {
    const ok = await confirmDialog({
      title: t("models.resetTitle"),
      body: t("models.resetBody"),
      confirmText: t("models.resetConfirm"),
    });
    if (ok) await patch({ resetModels: true }, t("models.resetDone"));
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
        <p className="settings-hint">{t("models.deepseekListingHint")}</p>
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
            {t("models.resetModels")}
          </button>
        ) : (
          <span />
        )}
        <span className="settings-form-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || (custom && models.length === 0)}
          >
            {busy ? t("common.pleaseWait") : t("common.save")}
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
  const t = useT();
  const custom = provider.kind === "custom";
  // 默认名字（按界面语言写的）不填进输入框，放在占位里：没改就不保存，清空就回到默认
  const initialName = isDefaultName(provider.id, provider.name) ? "" : provider.name;
  const [name, setName] = useState(initialName);
  const [key, setKey] = useState<KeyDraft>({ kind: "keep" });
  const [apiKeyEnv, setApiKeyEnv] = useState(provider.credential.apiKeyEnv ?? "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(provider.api ?? "openai-completions");
  const [busy, setBusy] = useState(false);
  const env = custom ? (apiKeyEnv.trim() ? [apiKeyEnv.trim()] : []) : provider.credential.env;

  const save = async () => {
    const url = baseUrl.trim();
    if (custom && !url) return toast(t("models.baseUrlRequired"), "error");
    // 改了地址：不是 HTTPS、在内网时先确认
    if (url && url !== (provider.baseUrl ?? "")) {
      const found = await urlWarnings(url);
      if (
        found.length > 0 &&
        !(await confirmDialog({
          title: t("models.confirmUrl"),
          body: (
            <>
              {found.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </>
          ),
          confirmText: t("models.saveAnyway"),
        }))
      ) {
        return;
      }
    }
    const patch: Record<string, unknown> = {};
    if (name.trim() !== initialName) patch.name = name.trim();
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
          ? t("models.savedRefit", { protocol: PROTOCOL_LABELS[protocol], count: refitted })
          : t("models.savedConnection"),
      );
    } catch (e) {
      toast(errorText(e as ApiError), "error");
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
        <span>{t("models.displayName")}</span>
        <input
          value={name}
          maxLength={60}
          placeholder={providerLabel(provider.id, "")}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {custom && (
        <p className="settings-hint">{t("models.providerIdFixed", { id: provider.id })}</p>
      )}
      <KeyField
        masked={provider.credential.masked}
        env={env}
        envDetected={provider.credential.envDetected}
        draft={key}
        onDraft={setKey}
      />
      {custom && (
        <label className="field">
          <span>{t("models.envName")}</span>
          <input
            value={apiKeyEnv}
            placeholder="MY_GATEWAY_API_KEY"
            maxLength={100}
            onChange={(e) => setApiKeyEnv(e.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>{t("models.baseUrl")}</span>
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
          {provider.defaultBaseUrl
            ? t("models.defaultUrlWith", { url: provider.defaultBaseUrl })
            : t("models.defaultUrl")}
        </p>
      )}
      {custom && (
        <div className="field">
          <span>{t("models.protocol")}</span>
          <Select
            label={t("models.protocol")}
            value={protocol}
            options={MODEL_PROTOCOLS.map((p) => ({ value: p, label: PROTOCOL_LABELS[p] }))}
            onChange={(v) => setProtocol(v as ModelProtocol)}
          />
        </div>
      )}
      <div className="settings-form-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? t("common.pleaseWait") : t("common.save")}
        </button>
      </div>
    </form>
  );
}
