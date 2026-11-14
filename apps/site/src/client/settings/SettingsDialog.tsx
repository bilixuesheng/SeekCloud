import { THINKING_EFFORTS, type ThinkingEffort } from "@seekcloud/protocol";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { type ApiError, api } from "../api";
import type { GitHubStatus } from "../GitHubConnectCard";
import { GitHubMark } from "../GitHubMark";
import { CloseIcon, MoonIcon, SettingsIcon, SparkIcon, UserIcon } from "../Icons";
import { LegalLink } from "../legal/LegalPage";
import { navigate, type SettingsSection } from "../router";
import { effortLabels } from "../session/ModelPicker";
import { reloadModels } from "../session/useModels";
import { currentTheme, setTheme, type Theme } from "../theme";
import { ExportData } from "./DataSettings";

const sections: Array<{ id: SettingsSection; name: string; icon: ReactNode }> = [
  { id: "general", name: "通用", icon: <SettingsIcon /> },
  { id: "github", name: "GitHub", icon: <GitHubMark size={15} /> },
  { id: "account", name: "账户", icon: <UserIcon /> },
];

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
  section: SettingsSection;
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
            ) : section === "github" ? (
              <GitHubSettings notice={notice} onGitHubChanged={onGitHubChanged} />
            ) : (
              <AccountSettings
                notice={notice}
                onSignedOut={onSignedOut}
                onProfileChanged={onProfileChanged}
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

/** 通用：外观和默认思考强度。 */
function GeneralSettings() {
  return (
    <>
      <ThemeSettings />
      <DefaultEffortSettings />
    </>
  );
}

/** 外观：三个缩略图就是单选项；缩略图里画一个小窗口，颜色写死，不跟着当前外观变。 */
function ThemeSettings() {
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

/**
 * 新会话默认的思考强度：四档一排，点了当场保存，没存上就拨回去并说明原因。
 * 存好以后重新取模型列表，首页的弹层和"恢复默认"跟着用新的值。
 */
function DefaultEffortSettings() {
  const [effort, setEffort] = useState<ThinkingEffort>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<{ effort: ThinkingEffort }>("/api/settings/default-effort").then(
      (res) => setEffort(res.effort),
      (e: ApiError) => setError(e.message),
    );
  }, []);

  const choose = async (next: ThinkingEffort) => {
    if (!effort || next === effort) return;
    const before = effort;
    setEffort(next);
    setError(undefined);
    try {
      await api("/api/settings/default-effort", { effort: next }, "PUT");
      reloadModels();
    } catch (e) {
      setEffort(before);
      setError((e as ApiError).message);
    }
  };

  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <SparkIcon size={16} />
        <h2>默认思考强度</h2>
      </div>
      <fieldset className="segmented" disabled={!effort}>
        <legend className="visually-hidden">默认思考强度</legend>
        {THINKING_EFFORTS.map((e) => (
          <label key={e} className={`segment ${e}${effort === e ? " current" : ""}`}>
            <input
              type="radio"
              name="default-effort"
              value={e}
              checked={effort === e}
              onChange={() => void choose(e)}
            />
            <span className="segment-label">{effortLabels[e]}</span>
          </label>
        ))}
      </fieldset>
      <p className="settings-group-hint">新会话默认使用这一档，已有的会话不受影响。</p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </section>
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
function GitHubSettings({
  notice,
  onGitHubChanged,
}: {
  notice?: string;
  onGitHubChanged: () => void;
}) {
  const [error, setError] = useState(notice);
  const [labels, setLabels] = useState<AiLabels>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<AiLabels>("/api/settings/ai-labels").then(setLabels, (e: ApiError) => setError(e.message));
  }, []);

  const toggle = async (key: keyof AiLabels) => {
    if (!labels || saving) return;
    const next = { ...labels, [key]: !labels[key] };
    setLabels(next);
    setSaving(true);
    setError(undefined);
    try {
      setLabels(await api<AiLabels>("/api/settings/ai-labels", next, "PUT"));
    } catch (e) {
      setLabels(labels);
      setError((e as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <section className="settings-section">
        <h2>账号</h2>
        <ul className="settings-list">
          <GitHubRow onChanged={onGitHubChanged} onError={setError} />
        </ul>
      </section>

      <section className="settings-section">
        <h2>AI 标识</h2>
        <ul className="settings-list">
          <SwitchRow
            name="署名"
            sub="在 issue、PR、评论和 review 的末尾注明内容由 SeekCloud 生成（AI）。"
            checked={labels?.signature}
            onToggle={() => void toggle("signature")}
          />
          <SwitchRow
            name="提交尾注"
            sub="在提交说明的末尾添加 Generated-by: SeekCloud (AI)。"
            checked={labels?.commitTrailer}
            onToggle={() => void toggle("commitTrailer")}
          />
        </ul>
        <p className="settings-hint">
          关闭后，DeepSeek 在 GitHub 上留下的内容不再带 AI 标识。是否关闭由你自行负责。
        </p>
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

/** 账户：密码、导出数据、登录状态、开源声明。 */
function AccountSettings({
  notice,
  onSignedOut,
  onProfileChanged,
}: {
  notice?: string;
  onSignedOut: () => void;
  onProfileChanged: () => void;
}) {
  const error = notice;
  const [confirmLogout, setConfirmLogout] = useState(false);

  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <section className="settings-section">
        <h2>昵称</h2>
        <NicknameRow onChanged={onProfileChanged} />
      </section>

      <section className="settings-section">
        <h2>密码</h2>
        <PasswordRow />
      </section>

      <section className="settings-section">
        <h2>导出数据</h2>
        <ExportData />
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

      <section className="settings-section">
        <h2>开源声明</h2>
        <p className="settings-hint">
          SeekCloud 使用的开源软件及其许可证，请参阅 <LegalLink doc="licenses" newTab />。
        </p>
      </section>
    </>
  );
}

/** 修改密码：先输当前密码，新密码填两遍。改完后当前设备保持登录，其他设备退出。 */
/**
 * 昵称：SeekCloud 称呼管理员时用的名字（照 Claude 的"希望 Claude 怎么称呼你"）。
 * 现在显示在侧栏底部和首页的问候语里；以后的系统提示词也带上它，Agent 称呼你时用（#59）。
 * 点"修改"就地改，去掉首尾空格，1–20 个字。
 */
function NicknameRow({ onChanged }: { onChanged: () => void }) {
  const [nickname, setNickname] = useState<string | null>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<{ nickname: string | null }>("/api/me").then(
      (me) => setNickname(me.nickname),
      (e: ApiError) => setError(e.message),
    );
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ nickname: string }>("/api/me/nickname", { nickname: draft }, "PUT");
      setNickname(res.nickname);
      setEditing(false);
      onChanged();
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
          <span className="settings-row-name">{nickname || "未设置"}</span>
          <span className="settings-row-sub">SeekCloud 称呼你时使用的名字。</span>
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
            {nickname ? "修改" : "设置"}
          </button>
        )}
      </div>
      {editing && (
        <form className="settings-form" onSubmit={submit}>
          <label className="field">
            <span>昵称（最多 20 个字）</span>
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
              取消
            </button>
            <button type="submit" className="primary" disabled={busy}>
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

function PasswordRow() {
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "alert" | "notice"; text: string }>();

  const close = () => {
    setEditing(false);
    setCurrent("");
    setNext("");
    setConfirm("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      setMessage({ tone: "alert", text: "两次输入的新密码不一致" });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      await api("/api/auth/password", { currentPassword: current, newPassword: next });
      close();
      setMessage({ tone: "notice", text: "密码已修改，其他设备已退出登录。" });
    } catch (e) {
      setMessage({ tone: "alert", text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">管理员密码</span>
          <span className="settings-row-sub">修改后，其他设备将退出登录。</span>
        </span>
        {!editing && (
          <button
            type="button"
            className="pill-button"
            onClick={() => {
              setEditing(true);
              setMessage(undefined);
            }}
          >
            修改
          </button>
        )}
      </div>
      {editing && (
        <form className="settings-form" onSubmit={submit}>
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
            <span>当前密码</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label className="field">
            <span>新密码（至少 8 位）</span>
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
            <span>确认新密码</span>
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
              取消
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "请稍候…" : "修改密码"}
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

/** GitHub：关联了就显示账号，可以解除关联；没关联时跳到 GitHub 授权，回来还是这一页。 */
function GitHubRow({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<GitHubStatus>();
  // 解除关联要点两下：第一下变成"确认解除"，免得误点。
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<GitHubStatus>("/api/github/status").then(setStatus, (e: ApiError) => onError(e.message));
  }, [onError]);
  useEffect(load, [load]);

  const unlink = async () => {
    setBusy(true);
    try {
      await api("/api/github/unlink", {});
      setConfirming(false);
      load();
      onChanged();
    } catch (e) {
      onError((e as ApiError).message);
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
          {status ? (login ?? "未关联") : ""}
          {confirming && " · 解除关联后 DeepSeek 将无法访问你的仓库"}
        </span>
      </span>
      {!status ? null : login ? (
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
              确认解除
            </button>
          </span>
        ) : (
          <button type="button" className="pill-button" onClick={() => setConfirming(true)}>
            解除关联
          </button>
        )
      ) : (
        <a className="pill-button accent" href="/api/auth/github/start?next=/settings/github">
          关联
        </a>
      )}
    </li>
  );
}
