import { type FormEvent, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "./api";
import { type AuthResult, type Provider, providerNames } from "./auth-results";
import { clientConfig } from "./config";
import { useSerifReady } from "./fonts";
import { GitHubMark } from "./GitHubMark";
import { GoogleMark } from "./GoogleMark";
import { useHumanCheck } from "./human-check";
import { Logo } from "./Logo";
import { LegalLink } from "./legal/LegalPage";

type Step = "email" | "code" | "pending";

/** 陌生的第三方账号（GitHub、Google）：见服务端 auth/third-party.ts。 */
interface Pending {
  provider: Provider;
  login: string;
  email: string | null;
  emailTaken: boolean;
  canRegister: boolean;
}

export function LoginPage({
  onSignedIn,
  authResult,
}: {
  onSignedIn: () => void;
  /** 第三方授权跳回来时地址里的结果。 */
  authResult: AuthResult | null;
}) {
  const [step, setStep] = useState<Step>(authResult?.kind === "pending" ? "pending" : "email");
  const [pending, setPending] = useState<Pending>();
  // 陌生的第三方账号选了"创建新账户"：在选择页里填邀请码。
  const [registering, setRegistering] = useState(false);
  // 选了"登录已有账户再绑定"：登录页上提示一句，登录后再确认绑定。
  const [linkHint, setLinkHint] = useState<string>();
  const [googleLogin, setGoogleLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [needInvite, setNeedInvite] = useState(false);
  const [error, setError] = useState<string | undefined>(
    authResult?.kind === "notice" ? authResult.message : undefined,
  );
  const info = authResult?.kind === "info" ? authResult.message : undefined;
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  // 人机验证：发验证码一个，注册一个（令牌和操作绑定）。
  const sendCheck = useHumanCheck("send_code", step !== "pending");
  const signupCheck = useHumanCheck("signup", needInvite || registering);
  const codeInput = useRef<HTMLInputElement>(null);
  const inviteInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    clientConfig().then((config) => setGoogleLogin(config.googleLogin));
  }, []);

  useEffect(() => {
    if (step !== "pending") return;
    api<Pending>("/api/auth/pending").then(setPending, () => {
      // 过期了（超过 10 分钟）：回到普通的登录。
      setStep("email");
      setError("授权已过期，请重新登录。");
    });
  }, [step]);

  // 换到下一步时，把光标放到该填的框里。
  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);
  useEffect(() => {
    if (needInvite || registering) inviteInput.current?.focus();
  }, [needInvite, registering]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () =>
    run(async () => {
      await api("/api/auth/email/send-code", {
        email,
        humanCheckToken: await sendCheck.token(),
      });
      setStep("code");
      setResendIn(60);
    });

  const verify = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api("/api/auth/email/verify", {
          email,
          code,
          ...(needInvite && {
            inviteCode,
            acceptTerms: agreed,
            humanCheckToken: await signupCheck.token(),
          }),
        });
        onSignedIn();
      } catch (e) {
        // 新邮箱：不算出错，改成让用户填邀请码。
        if ((e as ApiError).code === "invite_required") setNeedInvite(true);
        else throw e;
      }
    });
  };

  const changeEmail = () => {
    setStep("email");
    setCode("");
    setInviteCode("");
    setNeedInvite(false);
    setError(undefined);
  };

  const registerFromPending = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      await api("/api/auth/pending/register", {
        inviteCode,
        acceptTerms: agreed,
        humanCheckToken: await signupCheck.token(),
      });
      onSignedIn();
    });
  };

  /** 选"登录已有账户再绑定"：回到登录，登录以后首页会请用户确认绑定。 */
  const linkExisting = (p: Pending) => {
    setRegistering(false);
    setLinkHint(`登录后，将请你确认绑定 ${providerNames[p.provider]} 账号 ${p.login}。`);
    if (p.emailTaken && p.email) setEmail(p.email);
    setStep("email");
  };

  const cancelPending = () =>
    run(async () => {
      await api("/api/auth/pending/cancel", {});
      setPending(undefined);
      setRegistering(false);
      setStep("email");
    });

  const title =
    step === "pending"
      ? pending
        ? `${providerNames[pending.provider]} 账号尚未绑定`
        : "请稍候"
      : step === "email"
        ? "登录或注册"
        : needInvite
          ? "填写邀请码"
          : "输入验证码";

  const nameReady = useSerifReady("SeekCloud");

  const errorAlert = error && (
    <p className="alert" role="alert">
      {error}
    </p>
  );

  // 注册时必须勾选：表单的 required 先拦一次，服务端还会再查。
  const termsField = (
    <label className="consent">
      <input
        type="checkbox"
        required
        checked={agreed}
        onChange={(e) => setAgreed(e.target.checked)}
      />
      <span>
        我已阅读并同意 <LegalLink doc="terms" newTab /> 和 <LegalLink doc="privacy" newTab />
      </span>
    </label>
  );

  const inviteField = (
    <label className="field">
      <span>邀请码</span>
      <input
        ref={inviteInput}
        className="invite-input"
        autoCapitalize="characters"
        autoComplete="off"
        placeholder="ABCD-EFGH"
        required
        value={inviteCode}
        onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
      />
    </label>
  );

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size={96} />
        <p className={`auth-name serif-text${nameReady ? "" : " pending"}`}>SeekCloud</p>
        <p className="auth-tagline">代码无界，智能随行</p>
      </div>
      <main className="auth-card">
        <h1>{title}</h1>

        {step === "pending" ? (
          pending && (
            <div className="stack">
              <p className="notice">
                {providerNames[pending.provider]} 账号 <strong>{pending.login}</strong> 尚未绑定
                SeekCloud 账户。
              </p>
              {registering ? (
                <form className="stack" onSubmit={registerFromPending}>
                  <p className="hint">
                    将以 <strong>{pending.email}</strong> 创建新账户。内测期间需凭邀请码注册。
                  </p>
                  {inviteField}
                  {termsField}
                  {errorAlert}
                  <button type="submit" className="primary" disabled={busy}>
                    {busy ? "请稍候…" : "注册并登录"}
                  </button>
                  <button
                    type="button"
                    className="text-button center"
                    onClick={() => setRegistering(false)}
                  >
                    返回
                  </button>
                </form>
              ) : (
                <>
                  {pending.emailTaken ? (
                    <p className="hint">
                      <strong>{pending.email}</strong> 已注册
                      SeekCloud。请先通过邮箱验证码登录该账户，再确认绑定。
                    </p>
                  ) : (
                    !pending.canRegister && (
                      <p className="hint">
                        该账号没有已验证的邮箱，无法用于注册。可登录已有账户后进行绑定。
                      </p>
                    )
                  )}
                  {errorAlert}
                  {pending.canRegister && (
                    <button type="button" className="primary" onClick={() => setRegistering(true)}>
                      创建新账户
                    </button>
                  )}
                  <button
                    type="button"
                    className={pending.canRegister ? "secondary" : "primary"}
                    onClick={() => linkExisting(pending)}
                  >
                    {pending.canRegister ? "已有账户，登录后绑定" : "登录后绑定"}
                  </button>
                  <button
                    type="button"
                    className="text-button center"
                    disabled={busy}
                    onClick={() => void cancelPending()}
                  >
                    不使用此账号
                  </button>
                </>
              )}
            </div>
          )
        ) : step === "email" ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
          >
            {linkHint || info ? (
              <p className="notice">{linkHint ?? info}</p>
            ) : (
              <p className="hint">我们将向你的邮箱发送 6 位验证码。</p>
            )}
            <label className="field">
              <span>邮箱</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {errorAlert}
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "正在发送…" : "发送验证码"}
            </button>
            <div className="divider">
              <span>或</span>
            </div>
            <a className="button secondary" href="/api/auth/github/start">
              <GitHubMark /> 使用 GitHub 继续
            </a>
            {googleLogin && (
              <a className="button secondary" href="/api/auth/google/start">
                <GoogleMark /> 使用 Google 继续
              </a>
            )}
          </form>
        ) : (
          <form className="stack" onSubmit={verify}>
            <p className="hint">
              验证码已发送至 <strong>{email}</strong>，10 分钟内有效。
              <button type="button" className="text-button" onClick={changeEmail}>
                更换邮箱
              </button>
            </p>
            <label className="field">
              <span>验证码</span>
              <input
                ref={codeInput}
                className="code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                placeholder="······"
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </label>
            {needInvite && (
              <>
                <p className="notice">
                  该邮箱尚未注册。内测期间需凭邀请码注册，邀请码可向已注册的用户获取。
                </p>
                {inviteField}
                {termsField}
              </>
            )}
            {errorAlert}
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "请稍候…" : needInvite ? "注册并登录" : "登录"}
            </button>
            <button
              type="button"
              className="text-button center"
              disabled={busy || resendIn > 0}
              onClick={() => void sendCode()}
            >
              {resendIn > 0 ? `${resendIn} 秒后可重新发送` : "重新发送验证码"}
            </button>
          </form>
        )}
        {/* 人机验证的小部件：平时看不见，需要人点一下时才出现在这里 */}
        {sendCheck.widget}
        {signupCheck.widget}
      </main>
      <footer className="auth-footer">
        <p>内测版 · 非 DeepSeek 官方产品</p>
        <p className="auth-footer-links">
          <LegalLink doc="terms" />
          <LegalLink doc="privacy" />
          <LegalLink doc="licenses" />
        </p>
      </footer>
    </div>
  );
}
