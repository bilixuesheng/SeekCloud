import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "./api";
import { useSerifReady } from "./fonts";
import { Logo } from "./Logo";
import { LegalLink } from "./legal/LegalPage";
import {
  logInWithPasskey,
  passkeyErrorText,
  passkeyLoginSupported,
} from "./settings/PasskeySettings";

/**
 * 登录页。setup 为 true 时还没设置过管理员密码，改成首次设置：填昵称（SeekCloud 称呼管理员时用）和两遍新密码，设完直接登录。
 * 开了两步验证时，密码对了接着输验证器 App 里的验证码（或者一个恢复码，#100）；也可以用通行密钥直接登录。
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
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(notice);
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
  const nameReady = useSerifReady("SeekCloud");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (setup && password !== confirm) {
      setError("两次输入的密码不一致");
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
      setError(err.message);
      // 超过 5 分钟没输验证码：回到输密码
      if (err.code === "login_expired") backToPassword(err.message);
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

  const backToPassword = (message?: string) => {
    setPending(undefined);
    setCode("");
    setUseRecovery(false);
    setError(message);
  };

  if (pending) {
    return (
      <AuthFrame nameReady={nameReady}>
        <h1>两步验证</h1>
        <form className="stack" onSubmit={submit}>
          <p className="hint">
            {useRecovery
              ? "请输入一个恢复码。每个恢复码只能使用一次。"
              : "请输入验证器 App 中显示的 6 位验证码。"}
          </p>
          <label className="field">
            <span>{useRecovery ? "恢复码" : "验证码"}</span>
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
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "请稍候…" : "验证并登录"}
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
              {useRecovery ? "使用验证码" : "使用恢复码"}
            </button>
            <button type="button" className="link-button" onClick={() => backToPassword()}>
              返回
            </button>
          </div>
          {useRecovery && (
            <p className="hint">
              恢复码也无法使用时，可在服务器的 apps/site 目录中运行{" "}
              <code>pnpm admin:reset-password</code>，同时关闭两步验证。
            </p>
          )}
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame nameReady={nameReady}>
      <h1>{setup ? "首次设置" : "登录"}</h1>
      <form className="stack" onSubmit={submit}>
        {setup && (
          <p className="hint">
            请设置昵称和管理员密码。昵称是 SeekCloud 称呼你时使用的名字，之后可在设置中修改。
          </p>
        )}
        {/* 只有一个账户，用户名是固定的；放一个看不见的用户名，密码管理器才能把密码存对 */}
        <input type="text" name="username" autoComplete="username" value="admin" hidden readOnly />
        {setup && (
          <label className="field">
            <span>昵称</span>
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
          <span>{setup ? "新密码（至少 8 位）" : "密码"}</span>
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
            <span>确认密码</span>
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
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {failed && (
          <p className="hint">
            忘记密码时，可在服务器的 apps/site 目录中运行 <code>pnpm admin:reset-password</code>{" "}
            重置。
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "请稍候…" : setup ? "设置密码并登录" : "登录"}
        </button>
        {!setup && passkeyLoginSupported() && (
          <button type="button" className="secondary" disabled={busy} onClick={passkey}>
            使用通行密钥登录
          </button>
        )}
      </form>
    </AuthFrame>
  );
}

/** 登录页的外框：标志、名字、标语、卡片和页脚。 */
function AuthFrame({ nameReady, children }: { nameReady: boolean; children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size={96} />
        <p className={`auth-name serif-text${nameReady ? "" : " pending"}`}>SeekCloud</p>
        <p className="auth-tagline">代码无界，智能随行</p>
      </div>
      <main className="auth-card">{children}</main>
      <footer className="auth-footer">
        <p>非 DeepSeek 官方产品</p>
        <p className="auth-footer-links">
          <LegalLink doc="licenses" />
        </p>
      </footer>
    </div>
  );
}
