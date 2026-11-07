import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { type ApiError, api } from "../api";
import { type Provider, providerNames } from "../auth-results";
import { clientConfig } from "../config";
import { GitHubMark } from "../GitHubMark";
import { GoogleMark } from "../GoogleMark";
import { CloseIcon, MailIcon, MoonIcon, SettingsIcon, ShieldIcon, UserIcon } from "../Icons";
import { navigate, type SettingsSection } from "../router";
import { currentTheme, setTheme, type Theme } from "../theme";
import { DeleteAccount, PrivacySettings } from "./DataSettings";

interface Identities {
  email: string;
  identities: Array<{ provider: Provider; login: string }>;
}

const marks: Record<Provider, ReactNode> = {
  github: <GitHubMark size={16} />,
  google: <GoogleMark size={16} />,
};

const sections: Array<{ id: SettingsSection; name: string; icon: ReactNode }> = [
  { id: "general", name: "通用", icon: <SettingsIcon /> },
  { id: "account", name: "账户", icon: <UserIcon /> },
  { id: "privacy", name: "隐私", icon: <ShieldIcon /> },
];

/**
 * 设置是一个弹窗，左边分类，右边内容；底下还是原来的页面。手机上占满整个屏幕。
 * Esc、右上角的 ✕、点弹窗外面都能关掉。
 */
export function SettingsDialog({
  section,
  notice,
  onClose,
  onEmailChanged,
  onSignedOut,
}: {
  section: SettingsSection;
  /** 绑定第三方账号跳回来时的结果。 */
  notice?: string;
  onClose: () => void;
  onEmailChanged: (email: string) => void;
  onSignedOut: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    dialog.current?.focus();
    document.title = "设置 · SeekCloud";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.title = "SeekCloud";
    };
  }, [onClose]);

  return (
    <div
      className="dialog-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
      >
        <header className="dialog-head">
          <h1>设置</h1>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置分类">
            {sections.map((item) => (
              <a
                key={item.id}
                href={`/settings/${item.id}`}
                className={`settings-nav-item${item.id === section ? " current" : ""}`}
                aria-current={item.id === section ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/settings/${item.id}`);
                }}
              >
                {item.icon}
                {item.name}
              </a>
            ))}
          </nav>
          <div className="settings-content" key={section}>
            {section === "general" ? (
              <GeneralSettings />
            ) : section === "privacy" ? (
              <PrivacySettings />
            ) : (
              <AccountSettings
                notice={notice}
                onEmailChanged={onEmailChanged}
                onSignedOut={onSignedOut}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const themes: Array<{ id: Theme; name: string }> = [
  { id: "light", name: "浅色" },
  { id: "dark", name: "深色" },
  { id: "system", name: "跟随系统" },
];

/**
 * 通用：外观。三个缩略图就是单选项；缩略图里画一个小窗口，
 * 颜色写死，不跟着当前外观变。
 */
function GeneralSettings() {
  const [theme, setThemeState] = useState(currentTheme);
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <MoonIcon />
        <h2>外观</h2>
      </div>
      <fieldset className="theme-tiles">
        <legend className="visually-hidden">外观</legend>
        {themes.map((item) => (
          <label
            key={item.id}
            className={`theme-tile ${item.id}${theme === item.id ? " current" : ""}`}
          >
            <input
              type="radio"
              name="theme"
              value={item.id}
              checked={theme === item.id}
              onChange={() => setTheme(item.id, () => flushSync(() => setThemeState(item.id)))}
            />
            <span className="theme-thumb" aria-hidden="true">
              <span className="theme-window">
                <i />
                <i />
                <b />
              </span>
            </span>
            <span className="theme-name">{item.name}</span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

/** 账户：邮箱、登录方式、退出。 */
function AccountSettings({
  notice,
  onEmailChanged,
  onSignedOut,
}: {
  notice?: string;
  onEmailChanged: (email: string) => void;
  onSignedOut: () => void;
}) {
  const [data, setData] = useState<Identities>();
  const [googleLogin, setGoogleLogin] = useState(false);
  const [error, setError] = useState(notice);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const load = useCallback(() => {
    api<Identities>("/api/account/identities").then(setData, (e: ApiError) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    clientConfig().then((config) => setGoogleLogin(config.googleLogin));
  }, [load]);

  const providers: Provider[] = ["github", ...(googleLogin ? (["google"] as const) : [])];
  // 已经绑定的 Google 也要显示（哪怕后来关掉了 Google 登录），好让人解绑。
  for (const linked of data?.identities ?? []) {
    if (!providers.includes(linked.provider)) providers.push(linked.provider);
  }

  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <section className="settings-section">
        <h2>邮箱</h2>
        {data && (
          <EmailRow
            email={data.email}
            onChanged={(email) => {
              setData({ ...data, email });
              onEmailChanged(email);
            }}
          />
        )}
      </section>

      <section className="settings-section">
        <h2>登录方式</h2>
        <p className="settings-hint">邮箱验证码登录始终可用，因此第三方账号均可解绑。</p>
        <ul className="settings-list">
          <li className="settings-row">
            <span className="settings-icon">
              <MailIcon />
            </span>
            <span className="settings-row-text">
              <span className="settings-row-name">邮箱验证码</span>
              <span className="settings-row-sub">{data?.email}</span>
            </span>
          </li>
          {data &&
            providers.map((provider) => (
              <IdentityRow
                key={provider}
                provider={provider}
                login={data.identities.find((i) => i.provider === provider)?.login}
                onChange={load}
                onError={setError}
              />
            ))}
        </ul>
      </section>

      <section className="settings-section">
        <h2>登录状态</h2>
        <ul className="settings-list">
          <li className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-name">在所有设备上退出</span>
              <span className="settings-row-sub">
                包括当前设备。如怀疑账户被他人登录，请使用此功能。
              </span>
            </span>
            {confirmLogout ? (
              <span className="settings-actions">
                <button
                  type="button"
                  className="pill-button"
                  onClick={() => setConfirmLogout(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="pill-button danger"
                  onClick={() => api("/api/auth/logout-all", {}).then(onSignedOut)}
                >
                  确认退出
                </button>
              </span>
            ) : (
              <button type="button" className="pill-button" onClick={() => setConfirmLogout(true)}>
                全部退出
              </button>
            )}
          </li>
        </ul>
      </section>

      {data && (
        <section className="settings-section">
          <h2>删除账户</h2>
          <DeleteAccount email={data.email} />
        </section>
      )}
    </>
  );
}

function IdentityRow({
  provider,
  login,
  onChange,
  onError,
}: {
  provider: Provider;
  login?: string;
  onChange: () => void;
  onError: (message: string) => void;
}) {
  // 解绑要点两下：第一下变成"确认解绑"，免得误点。
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = providerNames[provider];

  const unlink = async () => {
    setBusy(true);
    try {
      await api("/api/account/identities/unlink", { provider });
      setConfirming(false);
      onChange();
    } catch (e) {
      onError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="settings-row">
      <span className="settings-icon">{marks[provider]}</span>
      <span className="settings-row-text">
        <span className="settings-row-name">{name}</span>
        <span className="settings-row-sub">
          {login ?? "未绑定"}
          {confirming && provider === "github" && " · 解绑后 Agent 将无法访问你的仓库"}
        </span>
      </span>
      {login ? (
        confirming ? (
          <span className="settings-actions">
            <button type="button" className="pill-button" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button
              type="button"
              className="pill-button danger"
              disabled={busy}
              onClick={() => void unlink()}
            >
              确认解绑
            </button>
          </span>
        ) : (
          <button type="button" className="pill-button" onClick={() => setConfirming(true)}>
            解绑
          </button>
        )
      ) : (
        <a className="pill-button accent" href={`/api/auth/${provider}/start?next=/settings`}>
          绑定
        </a>
      )}
    </li>
  );
}

/** 换邮箱：填新邮箱 → 新邮箱收验证码 → 填验证码确认。旧邮箱会收到通知。 */
function EmailRow({ email, onChanged }: { email: string; onChanged: (email: string) => void }) {
  const [step, setStep] = useState<"idle" | "new" | "code">("idle");
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "alert" | "notice"; text: string }>();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      await action();
    } catch (e) {
      setMessage({ tone: "alert", text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api("/api/account/email/send-code", { email: newEmail });
      setStep("code");
    });
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await api<{ email: string }>("/api/account/email/confirm", { code });
      onChanged(result.email);
      setStep("idle");
      setNewEmail("");
      setCode("");
      setMessage({ tone: "notice", text: `邮箱已更换为 ${result.email}，原邮箱将收到通知。` });
    });
  };

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">{email}</span>
          <span className="settings-row-sub">用于接收登录验证码和通知</span>
        </span>
        {step === "idle" && (
          <button type="button" className="pill-button" onClick={() => setStep("new")}>
            更换
          </button>
        )}
      </div>
      {step === "new" && (
        <form className="settings-form" onSubmit={send}>
          <label className="field">
            <span>新邮箱</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </label>
          <div className="settings-form-actions">
            <button type="button" className="secondary" onClick={() => setStep("idle")}>
              取消
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "正在发送…" : "发送验证码"}
            </button>
          </div>
        </form>
      )}
      {step === "code" && (
        <form className="settings-form" onSubmit={confirm}>
          <p className="hint">
            验证码已发送至 <strong>{newEmail}</strong>，10 分钟内有效。
          </p>
          <label className="field">
            <span>验证码</span>
            <input
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          <div className="settings-form-actions">
            <button type="button" className="secondary" onClick={() => setStep("new")}>
              返回
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "请稍候…" : "确认更换"}
            </button>
          </div>
        </form>
      )}
      {message && (
        <p className={message.tone} role={message.tone === "alert" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
