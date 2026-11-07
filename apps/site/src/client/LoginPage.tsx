import { type FormEvent, useState } from "react";
import { type ApiError, api } from "./api";
import { useSerifReady } from "./fonts";
import { Logo } from "./Logo";
import { LegalLink } from "./legal/LegalPage";

/**
 * 登录页。setup 为 true 时还没设置过管理员密码，改成设置密码：填两遍新密码，设完直接登录。
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
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(notice);
  const [busy, setBusy] = useState(false);
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
      await api(setup ? "/api/auth/setup" : "/api/auth/login", { password });
      onSignedIn();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size={96} />
        <p className={`auth-name serif-text${nameReady ? "" : " pending"}`}>SeekCloud</p>
        <p className="auth-tagline">代码无界，智能随行</p>
      </div>
      <main className="auth-card">
        <h1>{setup ? "设置管理员密码" : "登录"}</h1>
        <form className="stack" onSubmit={submit}>
          <p className="hint">
            {setup ? (
              "首次使用，请设置管理员密码，至少 8 位。"
            ) : (
              <>
                忘记密码时，可在服务器的 apps/site 目录中运行 <code>pnpm admin:reset-password</code>{" "}
                重置。
              </>
            )}
          </p>
          {/* 只有一个账户，用户名是固定的；放一个看不见的用户名，密码管理器才能把密码存对 */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value="admin"
            hidden
            readOnly
          />
          <label className="field">
            <span>{setup ? "新密码" : "密码"}</span>
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
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "请稍候…" : setup ? "设置密码并登录" : "登录"}
          </button>
        </form>
      </main>
      <footer className="auth-footer">
        <p>非 DeepSeek 官方产品</p>
        <p className="auth-footer-links">
          <LegalLink doc="licenses" />
        </p>
      </footer>
    </div>
  );
}
