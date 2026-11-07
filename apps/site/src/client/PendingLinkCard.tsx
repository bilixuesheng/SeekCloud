import { useEffect, useState } from "react";
import { type ApiError, api } from "./api";
import { type Provider, providerNames } from "./auth-results";

interface Pending {
  provider: Provider;
  login: string;
}

/**
 * 登录前用了陌生的第三方账号、选了"登录已有账户再绑定"：登录以后在这里请用户确认。
 * 不自动绑定：公用电脑上前一个人授权过的账号，不能悄悄绑进下一个人的账户。
 */
export function PendingLinkCard() {
  const [pending, setPending] = useState<Pending>();
  const [result, setResult] = useState<{ tone: "notice" | "alert"; text: string }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Pending>("/api/auth/pending").then(setPending, () => undefined);
  }, []);

  if (result) {
    return (
      <p className={result.tone} role={result.tone === "alert" ? "alert" : "status"}>
        {result.text}
      </p>
    );
  }
  if (!pending) return null;
  const name = providerNames[pending.provider];

  const decide = async (link: boolean) => {
    setBusy(true);
    try {
      if (link) {
        await api("/api/auth/pending/link", {});
        setResult({
          tone: "notice",
          text: `已绑定 ${name} 账号 ${pending.login}，此后可使用该账号登录。`,
        });
      } else {
        await api("/api/auth/pending/cancel", {});
        setPending(undefined);
      }
    } catch (e) {
      setResult({ tone: "alert", text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card pending-link" aria-label={`绑定 ${name} 账号`}>
      <h2>
        是否将 {name} 账号 {pending.login} 绑定到当前账户？
      </h2>
      <p className="muted">绑定后可使用该账号登录。如果这不是你刚刚授权的账号，请选择"取消"。</p>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void decide(true)}>
          绑定
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          取消
        </button>
      </div>
    </section>
  );
}
