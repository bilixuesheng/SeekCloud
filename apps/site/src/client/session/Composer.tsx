import { type FormEvent, useEffect, useRef } from "react";
import { ArrowUpIcon } from "../Icons";

const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;

/**
 * 输入框：一行起，跟着内容长高，发送按钮在右边。电脑上回车发送、Shift+回车换行；手机上回车换行，点按钮发送。
 * 用输入法打字时的回车（选字）不算发送。
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  canSubmit = true,
  busy = false,
  submitLabel,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  canSubmit?: boolean;
  busy?: boolean;
  /** 发送按钮的无障碍名称，比如"发起会话"。 */
  submitLabel: string;
  autoFocus?: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const ready = !disabled && !busy && canSubmit && value.trim().length > 0;

  // 跟着内容长高，到 CSS 里的 max-height 为止。内容被清空时（发送之后）也要重新量。
  // biome-ignore lint/correctness/useExhaustiveDependencies: value 变了就要重新量高度
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus && !coarsePointer()) textarea.current?.focus();
  }, [autoFocus]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (ready) onSubmit();
  };

  return (
    <form className={`composer${disabled ? " disabled" : ""}`} onSubmit={submit}>
      <textarea
        ref={textarea}
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          if (coarsePointer()) return;
          e.preventDefault();
          submit();
        }}
      />
      <button
        type="submit"
        className="send"
        disabled={!ready}
        aria-label={submitLabel}
        title={submitLabel}
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : <ArrowUpIcon />}
      </button>
    </form>
  );
}
