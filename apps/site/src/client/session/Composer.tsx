import { type FormEvent, useEffect, useLayoutEffect, useRef } from "react";
import { ArrowUpIcon } from "../Icons";
import { keyboardOpen } from "../keyboard";

const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;

// 首页发起会话后跳到会话页：首页的输入框原来有焦点、输入法开着，会话页的输入框挂上时就接过去，输入法不收起。
// 输入法是关着的（安卓上按返回收起输入法时，输入框还留着焦点）就不接：接过去输入法会弹出来。
let handingOff = false;

/** 换页之前调用。 */
export function handOffFocus(): void {
  handingOff =
    (document.activeElement?.matches(".composer textarea") ?? false) &&
    (!coarsePointer() || keyboardOpen());
}

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
  // 按下发送按钮时输入法开着没有（输入框有焦点、可见区域被顶矮了）：开着的发完不关，关着的发完不弹出来。
  const keepKeyboard = useRef(false);
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

  // 用 useLayoutEffect：和首页的输入框卸下是同一次提交，焦点在同一段脚本里就接上，输入法来不及收起。
  useLayoutEffect(() => {
    if (!handingOff) return;
    handingOff = false;
    textarea.current?.focus();
  }, []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (ready) onSubmit();
    // 各家手机浏览器不完全一样，输入法开着时万一焦点还是丢了，发完拿回来。
    if (keepKeyboard.current && document.activeElement !== textarea.current) {
      textarea.current?.focus();
    }
    keepKeyboard.current = false;
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
        // 输入法开着时点发送，不让按钮抢走焦点：输入法不收起，发完可以接着打字。
        // 输入法关着时让按钮拿走焦点，输入框失焦，发完以后输入法也不会弹出来。
        onPointerDown={() => {
          keepKeyboard.current =
            document.activeElement === textarea.current && (!coarsePointer() || keyboardOpen());
        }}
        onMouseDown={(e) => {
          if (keepKeyboard.current) e.preventDefault();
        }}
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : <ArrowUpIcon />}
      </button>
    </form>
  );
}
