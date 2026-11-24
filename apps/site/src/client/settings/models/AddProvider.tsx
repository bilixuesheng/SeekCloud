import { MODEL_PROTOCOLS, type ModelProtocol } from "@seekcloud/protocol";
import { useMemo, useState } from "react";
import { type ApiError, api } from "../../api";
import { useCached } from "../../cached";
import { PlusIcon, SearchIcon } from "../../Icons";
import { t as translate, useT } from "../../i18n";
import { errorText } from "../../i18n/errors";
import { joinNames } from "../../i18n/format";
import { confirmDialog } from "../../ui/confirm";
import { Modal } from "../../ui/modal";
import { Select } from "../../ui/select";
import { toast, useErrorToast } from "../../ui/toast";
import { KeyField } from "./KeyField";
import { type DraftModel, fitDrafts, ModelEditor, specOfDraft } from "./ModelEditor";
import {
  CATALOG,
  type CatalogEntry,
  type KeyDraft,
  keyPatch,
  MODEL_PROVIDERS,
  PROTOCOL_LABELS,
  type ProviderView,
  providerLabel,
} from "./types";
import { urlWarnings } from "./url-check";

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * "添加模型提供商"（照 dsh）：卡片默认打开在"第三方模型提供商"，从目录里选一个、填 key 就行（地址、协议、
 * 模型列表由目录给）；"自定义模型 API" 给中转站、公司网关、自建服务：Provider ID、显示名称、基础 URL、
 * API 协议、凭据和至少一个模型。
 */
export function AddProvider({ onAdded }: { onAdded: (provider: ProviderView) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"catalog" | "custom">("catalog");
  const done = (provider: ProviderView) => {
    onAdded(provider);
    setOpen(false);
    toast(translate("models.added", { name: providerLabel(provider.id, provider.name) }));
  };
  return (
    <>
      <button type="button" className="add-provider-button" onClick={() => setOpen(true)}>
        <PlusIcon size={16} /> {t("models.addProvider")}
      </button>
      <Modal open={open} wide title={t("models.addProvider")} onClose={() => setOpen(false)}>
        <fieldset className="segmented add-provider-tabs">
          <legend className="visually-hidden">{t("models.providerType")}</legend>
          {(
            [
              ["catalog", t("models.thirdParty")],
              ["custom", t("models.customApi")],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className={`segment${tab === id ? " current" : ""}`}>
              <input
                type="radio"
                name="add-provider-tab"
                checked={tab === id}
                onChange={() => setTab(id)}
              />
              <span className="segment-label">{label}</span>
            </label>
          ))}
        </fieldset>
        {tab === "catalog" ? (
          <CatalogForm onCancel={() => setOpen(false)} onAdded={done} />
        ) : (
          <CustomForm onCancel={() => setOpen(false)} onAdded={done} />
        )}
      </Modal>
    </>
  );
}

function CatalogForm({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (provider: ProviderView) => void;
}) {
  const t = useT();
  const catalog = useCached<{ providers: CatalogEntry[] }>(CATALOG);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<CatalogEntry>();
  const [key, setKey] = useState<KeyDraft>({ kind: "keep" });
  const [busy, setBusy] = useState(false);
  useErrorToast(catalog.error);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog.data?.providers ?? []).filter(
      (p) =>
        !p.added &&
        (!q ||
          p.id.includes(q) ||
          p.name.toLowerCase().includes(q) ||
          providerLabel(p.id, p.name).toLowerCase().includes(q)),
    );
  }, [catalog.data, query]);

  const save = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const apiKey = keyPatch(key);
      onAdded(
        await api<ProviderView>(MODEL_PROVIDERS, {
          kind: "catalog",
          id: chosen.id,
          ...(apiKey ? { apiKey } : {}),
        }),
      );
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-form add-provider-form">
      {chosen ? (
        <>
          <div className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-name">{providerLabel(chosen.id, chosen.name)}</span>
              <span className="settings-row-sub">
                {[
                  chosen.id,
                  joinNames(chosen.protocols.map((p) => PROTOCOL_LABELS[p])),
                  t("models.modelCount", { count: chosen.models }),
                ].join(" · ")}
              </span>
            </span>
            <button type="button" className="pill-button" onClick={() => setChosen(undefined)}>
              {t("models.change")}
            </button>
          </div>
          <KeyField
            masked={null}
            env={chosen.env}
            envDetected={chosen.envDetected}
            draft={key}
            onDraft={setKey}
          />
          <p className="settings-hint">{t("models.envHint")}</p>
        </>
      ) : (
        <>
          <span className="probe-search">
            <SearchIcon />
            <input
              aria-label={t("models.searchProvider")}
              placeholder={t("models.searchProviderHint")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
          <ul className="catalog-list">
            {shown.map((p) => (
              <li key={p.id}>
                <button type="button" className="catalog-item" onClick={() => setChosen(p)}>
                  <span className="settings-row-name">{providerLabel(p.id, p.name)}</span>
                  <span className="settings-row-sub">
                    {[
                      p.id,
                      t("models.modelCount", { count: p.models }),
                      ...(p.envDetected ? [t("models.detected", { env: p.envDetected })] : []),
                    ].join(" · ")}
                  </span>
                </button>
              </li>
            ))}
            {catalog.data && shown.length === 0 && (
              <li className="settings-hint">{t("models.noProviderMatch")}</li>
            )}
          </ul>
        </>
      )}
      <div className="settings-form-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!chosen || busy}
          onClick={() => void save()}
        >
          {busy ? t("common.pleaseWait") : t("common.save")}
        </button>
      </div>
    </div>
  );
}

function CustomForm({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (provider: ProviderView) => void;
}) {
  const t = useT();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState<ModelProtocol>("openai-completions");
  const [key, setKey] = useState<KeyDraft>({ kind: "keep" });
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [models, setModels] = useState<DraftModel[]>([]);
  const [busy, setBusy] = useState(false);

  const idValid = PROVIDER_ID.test(id);
  const ready = idValid && baseUrl.trim() !== "" && models.length > 0;

  const save = async () => {
    // 不是 HTTPS、在内网时先确认（自己部署的模型可以是内网地址，只提示不拦）
    const found = await urlWarnings(baseUrl.trim());
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
        confirmText: t("models.addAnyway"),
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      const apiKey = keyPatch(key);
      onAdded(
        await api<ProviderView>(MODEL_PROVIDERS, {
          kind: "custom",
          id,
          name: name.trim() || undefined,
          api: protocol,
          baseUrl: baseUrl.trim(),
          ...(apiKey ? { apiKey } : {}),
          ...(apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
          models: models.map((m) => specOfDraft(m, "custom")),
        }),
      );
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    } finally {
      setBusy(false);
    }
  };

  const probe = baseUrl.trim()
    ? {
        api: protocol,
        baseUrl: baseUrl.trim(),
        ...(key.kind === "replace" && key.value.trim() ? { apiKey: key.value.trim() } : {}),
      }
    : undefined;

  return (
    <form
      className="settings-form add-provider-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void save();
      }}
    >
      <label className="field">
        <span>Provider ID</span>
        <input
          value={id}
          maxLength={40}
          placeholder="my-gateway"
          onChange={(e) => setId(e.target.value.toLowerCase())}
        />
      </label>
      <p className={`settings-hint${id && !idValid ? " warn" : ""}`}>
        {t("models.providerIdHint")}
      </p>
      <label className="field">
        <span>{t("models.displayName")}</span>
        <input
          value={name}
          maxLength={60}
          placeholder={id || t("models.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span>{t("models.baseUrl")}</span>
        <input
          value={baseUrl}
          inputMode="url"
          maxLength={500}
          placeholder="https://gateway.example/v1"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      <div className="field">
        <span>{t("models.protocol")}</span>
        <Select
          label={t("models.protocol")}
          value={protocol}
          options={MODEL_PROTOCOLS.map((p) => ({ value: p, label: PROTOCOL_LABELS[p] }))}
          onChange={(v) => {
            setProtocol(v as ModelProtocol);
            // 已经加的模型的思考档位按新协议调整
            setModels(fitDrafts(models, v as ModelProtocol));
          }}
        />
      </div>
      <p className="settings-hint">
        {t("models.protocolHint", { example: "https://gateway.example/v1beta" })}
      </p>
      <KeyField
        masked={null}
        env={apiKeyEnv.trim() ? [apiKeyEnv.trim()] : []}
        envDetected={null}
        draft={key}
        onDraft={setKey}
      />
      <label className="field">
        <span>{t("models.envName")}</span>
        <input
          value={apiKeyEnv}
          maxLength={100}
          placeholder="MY_GATEWAY_API_KEY"
          onChange={(e) => setApiKeyEnv(e.target.value)}
        />
      </label>
      <div className="field">
        <span>{t("model.list")}</span>
        <ModelEditor
          models={models}
          onChange={setModels}
          context={{ kind: "custom", protocol, probe }}
        />
      </div>
      <div className="settings-form-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className="primary" disabled={!ready || busy}>
          {busy ? t("common.pleaseWait") : t("common.save")}
        </button>
      </div>
    </form>
  );
}
