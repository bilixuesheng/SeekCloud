import { type FormEvent, useEffect, useRef, useState } from "react";
import { encode } from "uqr";
import { type ApiError, api } from "../api";
import { useCopy } from "../copy";
import { CheckIcon, CopyIcon } from "../Icons";
import { useT } from "../i18n";
import { errorText } from "../i18n/errors";
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
  const t = useT();
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
        toast(t("twoFactor.expired"), "error");
      } else if (step.kind === "scan" && err.code === "wrong_code") {
        const n = wrongCodes + 1;
        setWrongCodes(n);
        toast(n >= 2 ? t("twoFactor.wrongCodeHint") : t("error.wrong_code"), "error");
      } else {
        toast(errorText(err), "error");
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
        go({ kind: "codes", codes: res.recoveryCodes }, t("twoFactor.enabled"));
      });
    } else if (step.kind === "disable") {
      void run(async () => {
        await api("/api/auth/two-factor/disable", { password, code });
        onChanged();
        go({ kind: "idle" }, t("twoFactor.disabled"));
      });
    } else if (step.kind === "regenerate") {
      void run(async () => {
        const res = await api<{ recoveryCodes: string[] }>("/api/auth/two-factor/recovery-codes", {
          password,
          code,
        });
        onChanged();
        go({ kind: "codes", codes: res.recoveryCodes }, t("twoFactor.regenerated"));
      });
    }
  };

  const left = state.recoveryCodesLeft;
  const sub = state.enabled
    ? left <= 3
      ? t("twoFactor.onLow", { count: left })
      : t("twoFactor.on", { count: left })
    : t("twoFactor.offHint");
  const cancel = (
    <button type="button" className="secondary" onClick={() => go({ kind: "idle" })}>
      {t("common.cancel")}
    </button>
  );
  // 关弹窗时还要画着最后一步，播完收起的动画
  const lastStep = useRef<Step>(step);
  if (step.kind !== "idle") lastStep.current = step;
  const view = step.kind === "idle" ? lastStep.current : step;
  const titles: Record<Step["kind"], string> = {
    idle: t("twoFactor.title"),
    password: t("twoFactor.enableTitle"),
    scan: t("twoFactor.enableTitle"),
    codes: t("twoFactor.saveCodes"),
    disable: t("twoFactor.disableTitle"),
    regenerate: t("twoFactor.regenerateTitle"),
  };

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">{t("twoFactor.app")}</span>
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
              {t("twoFactor.regenerateTitle")}
            </button>
            <button type="button" className="pill-button" onClick={() => go({ kind: "disable" })}>
              {t("twoFactor.turnOff")}
            </button>
          </span>
        ) : (
          <button type="button" className="pill-button" onClick={() => go({ kind: "password" })}>
            {t("twoFactor.turnOn")}
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
                {busy ? t("common.pleaseWait") : t("common.continue")}
              </button>
            </div>
          </form>
        )}

        {view.kind === "scan" && (
          <form className="settings-form" onSubmit={submit}>
            <p className="settings-hint">{t("twoFactor.scanHint")}</p>
            <QrCode text={view.otpauthUrl} />
            <SecretKey secret={view.secret} />
            <CodeField value={code} onChange={setCode} label={t("twoFactor.code")} numeric />
            <div className="settings-form-actions">
              {cancel}
              <button type="submit" className="primary" disabled={busy}>
                {busy ? t("common.pleaseWait") : t("twoFactor.confirmEnable")}
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
              <p className="settings-hint">{t("twoFactor.disableHint")}</p>
            )}
            <PasswordField value={password} onChange={setPassword} />
            <CodeField value={code} onChange={setCode} label={t("twoFactor.codeOrRecovery")} />
            <div className="settings-form-actions">
              {cancel}
              <button
                type="submit"
                className={view.kind === "disable" ? "primary danger" : "primary"}
                disabled={busy}
              >
                {busy
                  ? t("common.pleaseWait")
                  : view.kind === "disable"
                    ? t("twoFactor.disableTitle")
                    : t("twoFactor.regenerate")}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <>
      {/* 和登录页一样放一个看不见的用户名，密码管理器才认得出是哪个账户 */}
      <input type="text" name="username" autoComplete="username" value="admin" hidden readOnly />
      <label className="field">
        <span>{t("password.current")}</span>
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
  numeric = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  /** 只有验证码（6 位数字）时弹数字键盘；能填恢复码时不弹。 */
  numeric?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode={numeric ? "numeric" : "text"}
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
  const t = useT();
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
      aria-label={t("twoFactor.qr")}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** 手动输入用的密钥：四个一组显示，复制时不带空格。 */
function SecretKey({ secret }: { secret: string }) {
  const t = useT();
  const [copied, copy] = useCopy(secret);
  return (
    <div className="secret-key">
      <span className="settings-row-sub">{t("twoFactor.secret")}</span>
      <code className="secret-key-text">{secret.replace(/(.{4})/g, "$1 ").trim()}</code>
      <button
        type="button"
        className="icon-button"
        aria-label={t("twoFactor.copySecret")}
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

/** 恢复码：只显示这一次。 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const [copied, copy] = useCopy(codes.join("\n"));
  return (
    <div className="settings-form">
      <p className="settings-hint">{t("twoFactor.codesHint")}</p>
      <ul className="recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <code className="recovery-code">{c}</code>
          </li>
        ))}
      </ul>
      <div className="settings-form-actions">
        <button type="button" className="secondary" onClick={copy}>
          {copied ? t("common.copied") : t("twoFactor.copyCodes")}
        </button>
        <button type="button" className="primary" onClick={onDone}>
          {t("twoFactor.saved")}
        </button>
      </div>
    </div>
  );
}
