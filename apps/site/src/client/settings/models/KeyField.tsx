import { useId, useState } from "react";
import type { KeyDraft } from "./types";

/**
 * API key 的输入框，照 dsh 的模型页：
 * - 已保存的 key 只显示脱敏预览，不能看、不能复制、不能剪切、不能改一部分；键入或粘贴是整个替换，
 *   Backspace、Delete 是暂存删除（保存后退回环境变量），取消就还是原来的；
 * - 正在填的草稿不空时有眼睛按钮看明文，改了以后重新遮住；
 * - 下面一行提示：用已保存的、检测到环境变量（绿）、没检测到（黄）、保存以替换、保存后删除。
 */
export function KeyField({
  label = "API 密钥",
  masked,
  env,
  envDetected,
  draft,
  onDraft,
  disabled,
}: {
  label?: string;
  /** 已保存的 key 的脱敏预览；没保存时为空。 */
  masked: string | null;
  /** 没填 key 时读哪些环境变量。 */
  env: string[];
  envDetected: string | null;
  draft: KeyDraft;
  onDraft: (draft: KeyDraft) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const saved = masked !== null && draft.kind === "keep";
  const value = draft.kind === "replace" ? draft.value : saved ? masked : "";

  const replace = (next: string) => {
    setShown(false);
    if (next === "") onDraft(masked !== null ? { kind: "delete" } : { kind: "keep" });
    else onDraft({ kind: "replace", value: next });
  };

  const hint = (() => {
    if (saved) return { tone: "ok", text: "使用已保存的密钥" };
    if (draft.kind === "replace") {
      return { tone: "", text: masked !== null ? "保存以替换已保存的密钥" : "保存后使用这个密钥" };
    }
    const fallback = envDetected
      ? { tone: "ok", text: `检测到环境变量 ${envDetected}` }
      : env.length > 0
        ? {
            tone: "warn",
            text: `未检测到 ${env.join("、")}，请输入 API 密钥或配置该环境变量`,
          }
        : { tone: "warn", text: "请输入 API 密钥" };
    if (draft.kind === "delete") {
      return {
        tone: "",
        text: `保存后删除已保存的密钥${env.length > 0 ? `，改用环境变量 ${env.join("、")}` : ""}`,
      };
    }
    return fallback;
  })();

  return (
    <div className="field key-field">
      <label htmlFor={id}>{label}</label>
      <span className="key-field-box">
        <input
          id={id}
          type={saved || !shown ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={env.length > 0 ? "留空使用环境认证" : "sk-…"}
          maxLength={400}
          value={value}
          // 已保存的 key：不能复制、剪切、选中改一部分
          onCopy={(e) => saved && e.preventDefault()}
          onCut={(e) => saved && e.preventDefault()}
          onKeyDown={(e) => {
            if (!saved) return;
            if (e.key === "Backspace" || e.key === "Delete") {
              e.preventDefault();
              onDraft({ kind: "delete" });
            } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
              replace(e.key);
            }
          }}
          onPaste={(e) => {
            if (!saved) return;
            e.preventDefault();
            replace(e.clipboardData.getData("text").trim());
          }}
          onChange={(e) => {
            if (saved) return;
            replace(e.target.value);
          }}
        />
        {draft.kind === "replace" && draft.value !== "" && (
          <button
            type="button"
            className="key-field-eye"
            aria-label={shown ? "隐藏密钥" : "显示密钥"}
            aria-pressed={shown}
            onClick={() => setShown(!shown)}
          >
            {shown ? "隐藏" : "显示"}
          </button>
        )}
      </span>
      <span className={`key-field-hint${hint.tone ? ` ${hint.tone}` : ""}`}>{hint.text}</span>
    </div>
  );
}
