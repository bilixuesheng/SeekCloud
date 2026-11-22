import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api";
import { shortDateTime } from "../session/relative-time";
import { Modal } from "../ui/modal";
import { toast } from "../ui/toast";
import { CodeField } from "./TwoFactorSettings";

/** 通行密钥（#100）：设置里添加、删除，登录页用它登录。 */

interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  usable: boolean;
}

interface PasskeyList {
  available: boolean;
  rpId: string | null;
  passkeys: Passkey[];
}

/** 浏览器弹出的验证被取消、超时、设备上已有，这些都不是接口的错，换成看得懂的说明。 */
export function passkeyErrorText(error: unknown): string {
  const e = error as { name?: string; code?: string; message?: string };
  if (e?.name === "NotAllowedError" || e?.code === "ERROR_CEREMONY_ABORTED") {
    return "验证已取消，或未在规定时间内完成。";
  }
  if (e?.name === "InvalidStateError" || e?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    return "此设备上已有该账户的通行密钥。";
  }
  if (typeof e?.code === "string" && typeof e?.message === "string" && !e.name) return e.message;
  return "通行密钥验证失败，请重试。";
}

/** 登录页的"使用通行密钥登录"：浏览器不支持时不显示。 */
export function passkeyLoginSupported(): boolean {
  return browserSupportsWebAuthn();
}

export async function logInWithPasskey(): Promise<void> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>(
    "/api/auth/passkeys/login/options",
    {},
  );
  const credential = await startAuthentication({ optionsJSON });
  await api("/api/auth/passkeys/login", { credential });
}

type Step = { kind: "idle" } | { kind: "add" } | { kind: "delete"; passkey: Passkey };

/** 设置"账户"里的通行密钥。身份来源没有这个接口（下游换掉了）时整节不显示。 */
export function PasskeySection({ twoFactor }: { twoFactor: boolean }) {
  const [list, setList] = useState<PasskeyList | null>();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const supported = browserSupportsWebAuthn();

  const load = useCallback(
    () => api<PasskeyList>("/api/auth/passkeys").then(setList, () => setList(null)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const go = (next: Step, notice?: string) => {
    setStep(next);
    setName(next.kind === "add" ? "通行密钥" : "");
    setPassword("");
    setCode("");
    if (notice) toast(notice);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const reauth = { password, ...(twoFactor ? { code } : {}) };
    try {
      if (step.kind === "add") {
        const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>(
          "/api/auth/passkeys/register/options",
          reauth,
        );
        const credential = await startRegistration({ optionsJSON });
        await api("/api/auth/passkeys/register", { name, credential });
        go({ kind: "idle" }, "通行密钥已添加。");
      } else if (step.kind === "delete") {
        await api(`/api/auth/passkeys/${step.passkey.id}`, reauth, "DELETE");
        go({ kind: "idle" }, "通行密钥已删除。");
      }
      await load();
    } catch (e) {
      toast(passkeyErrorText(e as ApiError), "error");
    } finally {
      setBusy(false);
    }
  };

  // 关弹窗时还要画着刚才那一步，播完收起的动画
  const lastStep = useRef<Step>(step);
  if (step.kind !== "idle") lastStep.current = step;
  const view = step.kind === "idle" ? lastStep.current : step;

  if (!list) return null;
  const unavailable = !list.available
    ? "通行密钥需要通过 HTTPS 访问主站（或在本机用 localhost 打开），并将环境变量 PUBLIC_URL 设为主站对外的地址。"
    : !supported
      ? "当前浏览器不支持通行密钥。"
      : undefined;

  return (
    <section className="settings-section">
      <h2>通行密钥</h2>
      <p className="settings-hint">
        使用设备的指纹、面容或锁屏密码登录，无需输入密码和验证码。通行密钥与主站的地址绑定，地址变更后需重新添加。
      </p>
      <div className="settings-card">
        {list.passkeys.map((p) => (
          <div key={p.id} className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-name">{p.name}</span>
              <span className={`settings-row-sub${p.usable ? "" : " warn"}`}>
                {p.usable
                  ? `添加于 ${shortDateTime(new Date(p.createdAt))}${
                      p.lastUsedAt ? ` · 最后使用于 ${shortDateTime(new Date(p.lastUsedAt))}` : ""
                    }`
                  : "主站地址已变更，此通行密钥无法使用"}
              </span>
            </span>
            <button
              type="button"
              className="pill-button"
              onClick={() => go({ kind: "delete", passkey: p })}
            >
              删除
            </button>
          </div>
        ))}
        {list.passkeys.length === 0 && <p className="settings-row-sub">尚未添加通行密钥。</p>}
        {!unavailable && (
          <button
            type="button"
            className="pill-button settings-card-action"
            onClick={() => go({ kind: "add" })}
          >
            添加通行密钥
          </button>
        )}
        {unavailable && <p className="settings-hint">{unavailable}</p>}

        <Modal
          open={step.kind !== "idle"}
          title={view.kind === "delete" ? "删除通行密钥" : "添加通行密钥"}
          onClose={() => go({ kind: "idle" })}
        >
          <form className="settings-form" onSubmit={submit}>
            {view.kind === "add" ? (
              <label className="field">
                <span>名称</span>
                <input
                  type="text"
                  maxLength={50}
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            ) : (
              <p className="settings-hint">
                删除“{view.kind === "delete" ? view.passkey.name : ""}
                ”后，将无法再用它登录。设备上保存的通行密钥需要在设备上另行删除。
              </p>
            )}
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {twoFactor && <CodeField value={code} onChange={setCode} label="验证码或恢复码" />}
            <div className="settings-form-actions">
              <button type="button" className="secondary" onClick={() => go({ kind: "idle" })}>
                取消
              </button>
              <button
                type="submit"
                className={view.kind === "delete" ? "primary danger" : "primary"}
                disabled={busy}
              >
                {busy ? "请稍候…" : view.kind === "add" ? "继续" : "删除"}
              </button>
            </div>
          </form>
        </Modal>
      </div>
    </section>
  );
}
