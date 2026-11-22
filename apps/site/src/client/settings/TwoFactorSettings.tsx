import { type FormEvent, useEffect, useRef, useState } from "react";
import { encode } from "uqr";
import { type ApiError, api } from "../api";
import { useCopy } from "../copy";
import { CheckIcon, CopyIcon } from "../Icons";
import { Modal } from "../ui/modal";
import { toast } from "../ui/toast";

/** 两步验证开了没有（/api/auth/two-factor）。 */
export interface TwoFactorState {
  enabled: boolean;
  recoveryCodesLeft: number;
}

/**
 * 两步验证的状态。身份来源没有这个接口（下游换掉了）时是 null，界面上不显示这一节和改密码时的验证码。
 * 还在取时是 undefined。
 */
export function useTwoFactor(): [TwoFactorState | null | undefined, () => void] {
  const [state, setState] = useState<TwoFactorState | null>();
  const [version, setVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 变了就重新取
  useEffect(() => {
    api<TwoFactorState>("/api/auth/two-factor").then(setState, () => setState(null));
  }, [version]);
  return [state, () => setVersion((v) => v + 1)];
}

type Step =
  | { kind: "idle" }
  | { kind: "password" }
  | { kind: "scan"; secret: string; otpauthUrl: string; setupToken: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "disable" }
  | { kind: "regenerate" };

/**
 * 设置"账户"里的两步验证（#100）：
 * - 开启：输当前密码 → 扫二维码（或手动输入密钥）→ 输一次验证码 → 显示 10 个恢复码（只这一次）；
 * - 关闭、重新生成恢复码：都要输当前密码和验证码（或恢复码）。
 */
export function TwoFactorRow({
  state,
  onChanged,
}: {
  state: TwoFactorState;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // 开启时连着输错几次：多半是服务器的时间不准
  const [wrongCodes, setWrongCodes] = useState(0);

  const go = (next: Step, notice?: string) => {
    setStep(next);
    setPassword("");
    setCode("");
    setWrongCodes(0);
    if (notice) toast(notice);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "setup_expired") {
        go({ kind: "password" });
        toast("设置已超时，请重新输入密码。", "error");
      } else if (step.kind === "scan" && err.code === "wrong_code") {
        const n = wrongCodes + 1;
        setWrongCodes(n);
        toast(
          n >= 2
            ? "验证码错误。如果多次输入仍然错误，请检查服务器的时间是否准确。"
            : "验证码错误。",
          "error",
        );
      } else {
        toast(err.message, "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind === "password") {
      void run(async () => {
        const res = await api<{ secret: string; otpauthUrl: string; setupToken: string }>(
          "/api/auth/two-factor/setup",
          { password },
        );
        go({ kind: "scan", ...res });
      });
    } else if (step.kind === "scan") {
      void run(async () => {
        const res = await api<{ recoveryCodes: string[] }>("/api/auth/two-factor/enable", {
          setupToken: step.setupToken,
          code,
        });
        onChanged();
        go({ kind: "codes", codes: res.recoveryCodes }, "两步验证已开启。");
      });
    } else if (step.kind === "disable") {
      void run(async () => {
        await api("/api/auth/two-factor/disable", { password, code });
        onChanged();
        go({ kind: "idle" }, "两步验证已关闭。");
      });
    } else if (step.kind === "regenerate") {
      void run(async () => {
        const res = await api<{ recoveryCodes: string[] }>("/api/auth/two-factor/recovery-codes", {
          password,
          code,
        });
        onChanged();
        go({ kind: "codes", codes: res.recoveryCodes }, "已生成新的恢复码，旧的恢复码已作废。");
      });
    }
  };

  const left = state.recoveryCodesLeft;
  const sub = state.enabled
    ? left <= 3
      ? `已开启，恢复码仅剩 ${left} 个，建议重新生成`
      : `已开启，恢复码剩余 ${left} 个`
    : "登录时除密码外，还需输入验证器 App 生成的验证码。";
  const cancel = (
    <button type="button" className="secondary" onClick={() => go({ kind: "idle" })}>
      取消
    </button>
  );
  // 关弹窗时还要画着最后一步，播完收起的动画
  const lastStep = useRef<Step>(step);
  if (step.kind !== "idle") lastStep.current = step;
  const view = step.kind === "idle" ? lastStep.current : step;
  const titles: Record<Step["kind"], string> = {
    idle: "两步验证",
    password: "开启两步验证",
    scan: "开启两步验证",
    codes: "保存恢复码",
    disable: "关闭两步验证",
    regenerate: "重新生成恢复码",
  };

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">验证器 App</span>
          <span className={`settings-row-sub${state.enabled && left <= 3 ? " warn" : ""}`}>
            {sub}
          </span>
        </span>
        {state.enabled ? (
          <span className="settings-actions">
            <button
              type="button"
              className="pill-button"
              onClick={() => go({ kind: "regenerate" })}
            >
              重新生成恢复码
            </button>
            <button type="button" className="pill-button" onClick={() => go({ kind: "disable" })}>
              关闭
            </button>
          </span>
        ) : (
          <button type="button" className="pill-button" onClick={() => go({ kind: "password" })}>
            开启
          </button>
        )}
      </div>

      <Modal
        open={step.kind !== "idle"}
        title={titles[view.kind]}
        onClose={() => go({ kind: "idle" })}
      >
        {view.kind === "password" && (
          <form className="settings-form" onSubmit={submit}>
            <PasswordField value={password} onChange={setPassword} />
            <div className="settings-form-actions">
              {cancel}
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "请稍候…" : "继续"}
              </button>
            </div>
          </form>
        )}

        {view.kind === "scan" && (
          <form className="settings-form" onSubmit={submit}>
            <p className="settings-hint">
              请使用验证器 App（如 Google Authenticator、Microsoft
              Authenticator、1Password）扫描二维码，或手动输入密钥，然后填写 App 中显示的 6
              位验证码。
            </p>
            <QrCode text={view.otpauthUrl} />
            <SecretKey secret={view.secret} />
            <CodeField value={code} onChange={setCode} label="验证码" />
            <div className="settings-form-actions">
              {cancel}
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "请稍候…" : "确认开启"}
              </button>
            </div>
          </form>
        )}

        {view.kind === "codes" && (
          <RecoveryCodes codes={view.codes} onDone={() => go({ kind: "idle" })} />
        )}

        {(view.kind === "disable" || view.kind === "regenerate") && (
          <form className="settings-form" onSubmit={submit}>
            {view.kind === "disable" && (
              <p className="settings-hint">关闭后，登录时只需输入密码，恢复码全部作废。</p>
            )}
            <PasswordField value={password} onChange={setPassword} />
            <CodeField value={code} onChange={setCode} label="验证码或恢复码" />
            <div className="settings-form-actions">
              {cancel}
              <button
                type="submit"
                className={view.kind === "disable" ? "primary danger" : "primary"}
                disabled={busy}
              >
                {busy ? "请稍候…" : view.kind === "disable" ? "关闭两步验证" : "重新生成"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      {/* 和登录页一样放一个看不见的用户名，密码管理器才认得出是哪个账户 */}
      <input type="text" name="username" autoComplete="username" value="admin" hidden readOnly />
      <label className="field">
        <span>当前密码</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </>
  );
}

/** 验证码（或恢复码）的输入框。 */
export function CodeField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode={label === "验证码" ? "numeric" : "text"}
        autoComplete="one-time-code"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={32}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** 二维码：自己画成 SVG（不用 innerHTML），浅色深色主题下都是白底黑点，验证器 App 才扫得出来。 */
function QrCode({ text }: { text: string }) {
  const { data, size } = encode(text, { ecc: "M", border: 2 });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      className="qr-code"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="两步验证的二维码"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** 手动输入用的密钥：四个一组显示，复制时不带空格。 */
function SecretKey({ secret }: { secret: string }) {
  const [copied, copy] = useCopy(secret);
  return (
    <div className="secret-key">
      <span className="settings-row-sub">密钥</span>
      <code className="secret-key-text">{secret.replace(/(.{4})/g, "$1 ").trim()}</code>
      <button type="button" className="icon-button" aria-label="复制密钥" onClick={copy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

/** 恢复码：只显示这一次。 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, copy] = useCopy(codes.join("\n"));
  return (
    <div className="settings-form">
      <p className="settings-hint">
        请将以下恢复码保存在安全的地方。无法使用验证器 App
        时，可用恢复码代替验证码登录；每个恢复码只能使用一次，此后不会再显示。
      </p>
      <ul className="recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <code className="recovery-code">{c}</code>
          </li>
        ))}
      </ul>
      <div className="settings-form-actions">
        <button type="button" className="secondary" onClick={copy}>
          {copied ? "已复制" : "复制恢复码"}
        </button>
        <button type="button" className="primary" onClick={onDone}>
          我已保存
        </button>
      </div>
    </div>
  );
}
