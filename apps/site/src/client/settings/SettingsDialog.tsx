import { type FormEvent, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api";
import { prefetch, setCached, useCached } from "../cached";
import type { GitHubStatus } from "../GitHubConnectCard";
import { GitHubMark } from "../GitHubMark";
import { CloseIcon } from "../Icons";
import { pageTitle, t, tRich, useLocale, useT } from "../i18n";
import { errorText } from "../i18n/errors";
import { shortDateTime } from "../i18n/format";
import { LegalLink } from "../legal/LegalPage";
import {
  type SettingsSectionEntry,
  type SettingsSectionProps,
  sectionName,
  useRegistry,
} from "../registry";
import { navigate } from "../router";
import { confirmDialog } from "../ui/confirm";
import { Modal } from "../ui/modal";
import { toast, useErrorToast } from "../ui/toast";
import { DEFAULT_EFFORT, LANGUAGE } from "./GeneralSettings";
import { MODEL_PROVIDERS } from "./ModelSettings";
import { PasskeySection } from "./PasskeySettings";
import { HOST_OFFLINE_GRACE } from "./SessionSettings";
import { CodeField, TwoFactorRow, useTwoFactor } from "./TwoFactorSettings";

/** 设置窗口里各分类用到的接口。 */
const AI_LABELS = "/api/settings/ai-labels";
const GITHUB_STATUS = "/api/github/status";
const ME = "/api/me";
const EXPORTS = "/api/account/export";

/** 地址里的分类不认识（或者没写）时打开哪一类：账户；下游拿掉了账户时打开排在最前面的。 */
export function resolveSection(
  sections: readonly SettingsSectionEntry[],
  id: string | undefined,
): SettingsSectionEntry | undefined {
  return (
    sections.find((s) => s.id === id) ?? sections.find((s) => s.id === "account") ?? sections[0]
  );
}

/**
 * 设置是一个弹窗，左边分类，右边内容；底下还是原来的页面。手机上占满整个屏幕。
 * Esc、右上角的 ✕、点弹窗外面都能关掉。
 */
export function SettingsDialog({
  section,
  notice,
  onClose,
  onSignedOut,
  onGitHubChanged,
  onProfileChanged,
  closing = false,
}: {
  /** 地址里的分类，比如 /settings/github 的 github。分类都从注册表来（trunk.tsx 登记主干的几类）。 */
  section: string | undefined;
  /** 关联 GitHub 跳回来时出的问题。 */
  notice?: string;
  onClose: () => void;
  onSignedOut: () => void;
  onGitHubChanged: () => void;
  /** 改了昵称以后（侧栏底部的名字、首页的问候语跟着变）。 */
  onProfileChanged: () => void;
  /** 正在关：播完收起的动画就拿掉（App 里的 usePresence）。 */
  closing?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const locale = useLocale();
  const sections = useRegistry().settingsSections;
  const current = resolveSection(sections, section);
  const Content = current?.component;

  // 各分类要的数据一打开就一起拉好，切过去直接有，不会等数据回来再冒出来
  useEffect(() => {
    prefetch([
      AI_LABELS,
      GITHUB_STATUS,
      DEFAULT_EFFORT,
      LANGUAGE,
      ME,
      EXPORTS,
      HOST_OFFLINE_GRACE,
      MODEL_PROVIDERS,
    ]);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 标题跟着界面语言：设置 · 云上求索 / Settings · SeekCloud
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了语言要重新设标题
  useEffect(() => {
    document.title = t("settings.windowTitle");
    return () => {
      document.title = pageTitle();
    };
  }, [locale]);

  return (
    <div
      className={`dialog-scrim${closing ? " closing" : ""}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={`settings-dialog${closing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        tabIndex={-1}
      >
        <header className="dialog-head">
          <h1>{t("settings.title")}</h1>
          <button
            type="button"
            className="icon-button"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label={t("settings.nav")}>
            {sections.map((item) => (
              <a
                key={item.id}
                href={`/settings/${item.id}`}
                className={`settings-nav-item${item === current ? " current" : ""}`}
                aria-current={item === current ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/settings/${item.id}`);
                }}
              >
                {item.icon}
                {sectionName(item)}
              </a>
            ))}
          </nav>
          <div className="settings-content" key={current?.id}>
            {Content && (
              <Content
                notice={notice}
                onSignedOut={onSignedOut}
                onGitHubChanged={onGitHubChanged}
                onProfileChanged={onProfileChanged}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** AI 标识的两个开关，和接口的字段一一对应。 */
interface AiLabels {
  signature: boolean;
  commitTrailer: boolean;
}

/**
 * GitHub：关联的账号，和 Agent 在 GitHub 上留的 AI 标识。
 * 两个开关各管各的，点了当场保存；没存上就拨回去，并说明原因。
 */
export function GitHubSettings({ notice, onGitHubChanged }: SettingsSectionProps) {
  const t = useT();
  const [failed, setError] = useState(notice);
  const loaded = useCached<AiLabels>(AI_LABELS);
  const labels = loaded.data;
  const error = failed ?? loaded.error;
  useErrorToast(error);
  const [saving, setSaving] = useState(false);

  const toggle = async (key: keyof AiLabels) => {
    if (!labels || saving) return;
    const next = { ...labels, [key]: !labels[key] };
    setCached(AI_LABELS, next);
    setSaving(true);
    setError(undefined);
    try {
      setCached(AI_LABELS, await api<AiLabels>(AI_LABELS, next, "PUT"));
    } catch (e) {
      setCached(AI_LABELS, labels);
      toast(errorText(e as ApiError), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="settings-section">
        <h2>{t("aiLabels.accounts")}</h2>
        <ul className="settings-list">
          <GitHubRow onChanged={onGitHubChanged} onError={setError} />
        </ul>
      </section>

      <section className="settings-section">
        <h2>{t("aiLabels.title")}</h2>
        <ul className="settings-list">
          <SwitchRow
            name={t("aiLabels.signature")}
            sub={t("aiLabels.signatureHint")}
            checked={labels?.signature}
            onToggle={() => void toggle("signature")}
          />
          <SwitchRow
            name={t("aiLabels.trailer")}
            sub={t("aiLabels.trailerHint")}
            checked={labels?.commitTrailer}
            onToggle={() => void toggle("commitTrailer")}
          />
        </ul>
        <p className="settings-hint">{t("aiLabels.hint")}</p>
      </section>
    </>
  );
}

/** 设置里带开关的一行。checked 还没取到时开关不显示，免得先画成关的再跳成开的。 */
function SwitchRow({
  name,
  sub,
  checked,
  onToggle,
}: {
  name: string;
  sub: string;
  checked: boolean | undefined;
  onToggle: () => void;
}) {
  return (
    <li className="settings-row">
      <span className="settings-row-text">
        <span className="settings-row-name">{name}</span>
        <span className="settings-row-sub">{sub}</span>
      </span>
      {checked !== undefined && (
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={name}
          className="switch"
          onClick={onToggle}
        >
          <span className="switch-knob" aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

/** 账户：昵称、密码、两步验证、通行密钥、登录状态、开源声明。 */
export function AccountSettings({ notice, onSignedOut, onProfileChanged }: SettingsSectionProps) {
  const t = useT();
  const error = notice;
  useErrorToast(error);
  const [twoFactor, refreshTwoFactor] = useTwoFactor();
  const logoutAll = async () => {
    const ok = await confirmDialog({
      title: t("account.logoutAllTitle"),
      body: t("account.logoutAllBody"),
      confirmText: t("account.logoutAllConfirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api("/api/auth/logout-all", {});
      onSignedOut();
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    }
  };

  return (
    <>
      <section className="settings-section">
        <h2>{t("setup.nickname")}</h2>
        <NicknameRow onChanged={onProfileChanged} />
      </section>

      <section className="settings-section">
        <h2>{t("login.password")}</h2>
        <PasswordRow twoFactor={twoFactor?.enabled ?? false} />
      </section>

      {twoFactor && (
        <section className="settings-section">
          <h2>{t("twoFactor.title")}</h2>
          <TwoFactorRow state={twoFactor} onChanged={refreshTwoFactor} />
        </section>
      )}

      {twoFactor !== undefined && <PasskeySection twoFactor={twoFactor?.enabled ?? false} />}

      <section className="settings-section">
        <h2>{t("account.sessions")}</h2>
        <ul className="settings-list">
          <DeviceRows onSignedOut={onSignedOut} />
          <li className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-name">{t("account.logoutAll")}</span>
              <span className="settings-row-sub">{t("account.logoutAllHint")}</span>
            </span>
            <button type="button" className="pill-button" onClick={() => void logoutAll()}>
              {t("account.logoutAllConfirm")}
            </button>
          </li>
        </ul>
      </section>

      <section className="settings-section">
        <h2>{t("legal.licenses")}</h2>
        <p className="settings-hint">
          {tRich("account.licensesHint", { link: <LegalLink doc="licenses" newTab /> })}
        </p>
      </section>
    </>
  );
}

/**
 * 昵称：SeekCloud 称呼管理员时用的名字（照 Claude 的"希望 Claude 怎么称呼你"）。
 * 现在显示在侧栏底部和首页的问候语里；以后的系统提示词也带上它，Agent 称呼你时用（#59）。
 * 点"修改"就地改，去掉首尾空格，1–20 个字。
 */
interface LoginDevice {
  id: string;
  client: "browser" | "app";
  deviceName: string | null;
  current: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** 设备的名字：App 是它报的型号，浏览器是登录时认出来的"Chrome · macOS"（认不出来的、以前登录的叫"浏览器"）。 */
const deviceLabel = (d: LoginDevice) =>
  d.deviceName ?? (d.client === "app" ? t("device.android") : t("device.browser"));

/**
 * 登录着的设备（#177）：浏览器和安卓 App，每台一行，能单独退出。身份来源没有这个接口（下游换掉了）时不显示。
 * 退出的是当前这台时和退出登录一样。
 */
function DeviceRows({ onSignedOut }: { onSignedOut: () => void }) {
  const t = useT();
  const [devices, setDevices] = useState<LoginDevice[]>();

  useEffect(() => {
    api<{ devices: LoginDevice[] }>("/api/auth/devices").then(
      (res) => setDevices(res.devices),
      () => setDevices([]),
    );
  }, []);

  const logOut = async (device: LoginDevice) => {
    const name = deviceLabel(device);
    const ok = await confirmDialog({
      title: device.current ? t("device.logoutCurrentTitle") : t("device.logoutTitle", { name }),
      body: device.current ? t("device.logoutCurrentBody") : t("device.logoutBody"),
      confirmText: t("device.logout"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/auth/devices/${device.id}`, {}, "DELETE");
      if (device.current) return onSignedOut();
      setDevices((list) => list?.filter((d) => d.id !== device.id));
      toast(t("device.loggedOut", { name }));
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    }
  };

  if (!devices?.length) return null;
  // 当前这台排最前，别的按最近使用
  const sorted = [...devices].sort((a, b) => Number(b.current) - Number(a.current));
  return (
    <>
      {sorted.map((d) => (
        <li key={d.id} className="settings-row">
          <span className="settings-row-text">
            <span className="settings-row-name">
              {deviceLabel(d)}
              {d.current && <span className="provider-kind">{t("device.current")}</span>}
            </span>
            <span className="settings-row-sub">
              {t(d.lastUsedAt ? "device.lastUsed" : "device.signedIn", {
                kind: d.client === "app" ? t("device.app") : t("device.web"),
                time: shortDateTime(new Date(d.lastUsedAt ?? d.createdAt)),
              })}
            </span>
          </span>
          <button type="button" className="pill-button" onClick={() => void logOut(d)}>
            {t("device.logout")}
          </button>
        </li>
      ))}
    </>
  );
}

function NicknameRow({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const me = useCached<{ nickname: string | null }>(ME);
  const nickname = me.data?.nickname;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setError] = useState<string>();
  const error = failed ?? me.error;
  useErrorToast(error);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ nickname: string }>("/api/me/nickname", { nickname: draft }, "PUT");
      setCached(ME, { ...me.data, nickname: res.nickname });
      setEditing(false);
      onChanged();
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">{nickname || t("nickname.unset")}</span>
          <span className="settings-row-sub">{t("nickname.hint")}</span>
        </span>
        {!editing && nickname !== undefined && (
          <button
            type="button"
            className="pill-button"
            onClick={() => {
              setDraft(nickname ?? "");
              setEditing(true);
              setError(undefined);
            }}
          >
            {nickname ? t("common.change") : t("common.set")}
          </button>
        )}
      </div>
      {editing && (
        <form className="settings-form" onSubmit={submit}>
          <label className="field">
            <span>{t("nickname.label")}</span>
            <input
              type="text"
              autoComplete="nickname"
              maxLength={20}
              required
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <div className="settings-form-actions">
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? t("common.pleaseWait") : t("common.save")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** 修改密码：先输当前密码（开了两步验证的再输验证码），新密码填两遍。改完后当前设备保持登录，其他设备退出。 */
function PasswordRow({ twoFactor }: { twoFactor: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState("");
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setEditing(false);
    setCurrent("");
    setCode("");
    setNext("");
    setConfirm("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      toast(t("password.mismatch"), "error");
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/password", {
        currentPassword: current,
        newPassword: next,
        ...(twoFactor ? { code } : {}),
      });
      close();
      toast(t("password.changed"));
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">{t("password.admin")}</span>
          <span className="settings-row-sub">{t("password.hint")}</span>
        </span>
        <button type="button" className="pill-button" onClick={() => setEditing(true)}>
          {t("common.change")}
        </button>
      </div>
      <Modal open={editing} title={t("password.title")} onClose={close}>
        <form className="settings-form" onSubmit={submit}>
          <p className="settings-hint">{t("password.modalHint")}</p>
          {/* 和登录页一样放一个看不见的用户名，密码管理器才能更新存着的密码 */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value="admin"
            hidden
            readOnly
          />
          <label className="field">
            <span>{t("password.current")}</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          {twoFactor && (
            <CodeField value={code} onChange={setCode} label={t("twoFactor.codeOrRecovery")} />
          )}
          <label className="field">
            <span>{t("setup.newPassword")}</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={256}
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("password.confirm")}</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={256}
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <div className="settings-form-actions">
            <button type="button" className="secondary" onClick={close}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? t("common.pleaseWait") : t("password.submit")}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** GitHub：关联了就显示账号，可以解除关联；没关联时跳到 GitHub 授权，回来还是这一页。 */
function GitHubRow({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const { data: status, error, reload: load } = useCached<GitHubStatus>(GITHUB_STATUS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (error) onError(error);
  }, [error, onError]);

  const unlink = async () => {
    const ok = await confirmDialog({
      title: t("github.unlinkTitle"),
      body: t("github.unlinkBody"),
      confirmText: t("github.unlink"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api("/api/github/unlink", {});
      load();
      onChanged();
      toast(t("github.unlinked"));
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    } finally {
      setBusy(false);
    }
  };

  const login = status?.connected ? status.login : undefined;
  return (
    <li className="settings-row">
      <span className="settings-icon">
        <GitHubMark size={16} />
      </span>
      <span className="settings-row-text">
        <span className="settings-row-name">GitHub</span>
        <span className="settings-row-sub">
          {/* 数据还没回来时先用一个空格占住这一行，回来以后不会把下面的内容往下顶 */}
          {status ? (login ?? t("github.notConnected")) : "\u00a0"}
        </span>
      </span>
      {!status ? null : login ? (
        <button type="button" className="pill-button" disabled={busy} onClick={() => void unlink()}>
          {t("github.unlink")}
        </button>
      ) : (
        <a className="pill-button accent" href="/api/auth/github/start?next=/settings/github">
          {t("github.connect")}
        </a>
      )}
    </li>
  );
}
