import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "./api";
import { useSerifReady } from "./fonts";
import { GlobeIcon } from "./Icons";
import { LOCALE_NAMES, LOCALES, type Locale, setLanguage, t, tRich, useLocale, useT } from "./i18n";
import { errorText } from "./i18n/errors";
import { Logo } from "./Logo";
import { LegalLink } from "./legal/LegalPage";
import {
  logInWithPasskey,
  passkeyErrorText,
  passkeyLoginSupported,
} from "./settings/PasskeySettings";
import { Select } from "./ui/select";

/**
 * 登录页。setup 为 true 时还没设置过管理员密码，改成首次设置：填昵称（称呼管理员时用）和两遍新密码，设完直接登录。
 * 开了两步验证时，密码对了接着输验证器 App 里的验证码（或者一个恢复码，#100）；也可以用通行密钥直接登录。
 * 文案都在文案目录里（#135），右上角可以切换界面语言（登录之前只记在这台浏览器上）。
 */
export function LoginPage({
  setup,
  onSignedIn,
  notice,
}: {
  setup: boolean;
  onSignedIn: () => void;
  /** 关联 GitHub 跳回来时出的问题，比如登录状态已过期。 */
  notice?: string;
}) {
  useT();
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // 出的问题：自己的（按语言现取）或者接口回来的
  const [error, setError] = useState<ApiError | string | undefined>(notice);
  const [busy, setBusy] = useState(false);
  // 输错过一次密码以后才提示怎么重置，平时不显示
  const [failed, setFailed] = useState(false);
  // 两步验证：密码对了以后的中间令牌（5 分钟），有它就显示输验证码的一步
  const [pending, setPending] = useState<string>();
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  // 进到输验证码这一步、换成恢复码时，光标直接放进输入框
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换成恢复码时输入框是新的，要再放一次光标
  useEffect(() => {
    if (pending) codeInput.current?.focus();
  }, [pending, useRecovery]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (setup && password !== confirm) {
      setError(t("setup.mismatch"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (pending) {
        await api("/api/auth/login/verify", { pendingToken: pending, code });
        onSignedIn();
        return;
      }
      const res = await api<{ pendingToken?: string } | undefined>(
        setup ? "/api/auth/setup" : "/api/auth/login",
        setup ? { nickname, password } : { password },
      );
      if (res?.pendingToken) {
        setPending(res.pendingToken);
        return;
      }
      onSignedIn();
    } catch (e) {
      const err = e as ApiError;
      setError(err);
      // 超过 5 分钟没输验证码：回到输密码
      if (err.code === "login_expired") backToPassword(err);
      else if (!setup && !pending && err.code !== "network") setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  // 通行密钥（#100）：通过了直接登录，不用密码和验证码
  const passkey = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await logInWithPasskey();
      onSignedIn();
    } catch (e) {
      setError(passkeyErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const backToPassword = (message?: ApiError) => {
    setPending(undefined);
    setCode("");
    setUseRecovery(false);
    setError(message);
  };

  const alert = error && (
    <p className="alert" role="alert">
      {typeof error === "string" ? error : errorText(error)}
    </p>
  );
  const command = <code>pnpm admin:reset-password</code>;

  if (pending) {
    return (
      <AuthFrame>
        <h1>{t("twoFactor.title")}</h1>
        <form className="stack" onSubmit={submit}>
          <p className="hint">
            {useRecovery ? t("twoFactor.enterRecovery") : t("twoFactor.enterCode")}
          </p>
          <label className="field">
            <span>{useRecovery ? t("twoFactor.recoveryCode") : t("twoFactor.code")}</span>
            <input
              key={useRecovery ? "recovery" : "totp"}
              type="text"
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete={useRecovery ? "off" : "one-time-code"}
              autoCapitalize="off"
              spellCheck={false}
              maxLength={useRecovery ? 32 : 7}
              required
              ref={codeInput}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          {alert}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t("common.pleaseWait") : t("twoFactor.submit")}
          </button>
          <div className="auth-links">
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setUseRecovery(!useRecovery);
                setCode("");
                setError(undefined);
              }}
            >
              {useRecovery ? t("twoFactor.useCode") : t("twoFactor.useRecovery")}
            </button>
            <button type="button" className="link-button" onClick={() => backToPassword()}>
              {t("common.back")}
            </button>
          </div>
          {useRecovery && <p className="hint">{tRich("twoFactor.recoveryHelp", { command })}</p>}
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <h1>{setup ? t("setup.title") : t("login.title")}</h1>
      <form className="stack" onSubmit={submit}>
        {setup && <p className="hint">{t("setup.hint")}</p>}
        {/* 只有一个账户，用户名是固定的；放一个看不见的用户名，密码管理器才能把密码存对 */}
        <input type="text" name="username" autoComplete="username" value="admin" hidden readOnly />
        {setup && (
          <label className="field">
            <span>{t("setup.nickname")}</span>
            <input
              type="text"
              autoComplete="nickname"
              maxLength={20}
              required
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
        )}
        <label className="field">
          <span>{setup ? t("setup.newPassword") : t("login.password")}</span>
          <input
            type="password"
            autoComplete={setup ? "new-password" : "current-password"}
            minLength={setup ? 8 : undefined}
            maxLength={setup ? 256 : undefined}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {setup && (
          <label className="field">
            <span>{t("setup.confirmPassword")}</span>
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
        )}
        {alert}
        {failed && <p className="hint">{tRich("login.forgot", { command })}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? t("common.pleaseWait") : setup ? t("setup.submit") : t("login.submit")}
        </button>
        {!setup && passkeyLoginSupported() && (
          <button type="button" className="secondary" disabled={busy} onClick={passkey}>
            {t("login.passkey")}
          </button>
        )}
      </form>
    </AuthFrame>
  );
}

/** 登录页的外框：右上角的语言切换，标志、名字、标语、卡片和页脚。 */
function AuthFrame({ children }: { children: ReactNode }) {
  const brand = t("brand.name");
  const nameReady = useSerifReady(brand);
  return (
    <div className="auth-page">
      <LanguageSwitch />
      <div className="auth-hero">
        <Logo size={96} />
        <p className={`auth-name serif-text${nameReady ? "" : " pending"}`}>{brand}</p>
        <p className="auth-tagline">{t("brand.tagline")}</p>
      </div>
      <main className="auth-card">{children}</main>
      <footer className="auth-footer">
        <p>{t("brand.notOfficial")}</p>
        <p className="auth-footer-links">
          <LegalLink doc="licenses" />
        </p>
      </footer>
    </div>
  );
}

/** 登录前切换界面语言：只记在这台浏览器上，登录后主站没设置过时再存上去（i18n 的 reconcileLanguage）。 */
function LanguageSwitch() {
  const locale = useLocale();
  return (
    <div className="auth-language">
      <GlobeIcon />
      <Select
        size="small"
        label={t("language.switch")}
        value={locale}
        options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
        onChange={(next) => setLanguage(next as Locale, "picker")}
      />
    </div>
  );
}
