import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ImageIcon,
  PaperclipIcon,
  PlusIcon,
  QueueIcon,
  ReturnIcon,
  StopIcon,
} from "../Icons";
import { useT } from "../i18n";
import { keyboardOpen } from "../keyboard";
import { Sheet, usePresence } from "../Motion";
import { MenuItem } from "./SessionHeader";

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
  working,
  attach,
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
  /**
   * Agent 在工作（照 Claude 的 App）：输入框是空的时，发送键是停止键；有字时发送键是"↵"（插进当前回合，
   * Agent 下一步读到），旁边一个"⌄"，点开是"稍后排队"（等这个回合结束再发）和"停止"（只停下回合，字留在输入框里）。
   */
  working?: { onStop: () => void; onLater: () => void; stopping: boolean };
  /**
   * 输入框左边的"+"（照 Claude）：附图片、附文件。vision：当前模型能不能识图。
   * 现在两项都还不能用（列表里的模型都不能识图；传文件进沙箱要等宿主机），点开写明原因。
   */
  attach?: { vision: boolean };
}) {
  const t = useT();
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
    <form
      className={`composer${disabled ? " disabled" : ""}${attach ? " with-attach" : ""}`}
      onSubmit={submit}
    >
      {attach && (
        <PopMenu
          label={t("composer.attach")}
          className="composer-attach"
          menuClassName="attach-menu"
          trigger={<PlusIcon size={18} />}
        >
          {() => (
            <>
              <MenuItem icon={<ImageIcon />} disabled onClick={() => undefined}>
                {t("composer.image")}
                <span className="sheet-item-hint">
                  {attach.vision ? t("composer.imageSoon") : t("composer.imageUnsupported")}
                </span>
              </MenuItem>
              <MenuItem icon={<PaperclipIcon />} disabled onClick={() => undefined}>
                {t("composer.file")}
                <span className="sheet-item-hint">{t("composer.fileSoon")}</span>
              </MenuItem>
            </>
          )}
        </PopMenu>
      )}
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
      {working && !value.trim() ? (
        <button
          type="button"
          className="send stop"
          aria-label={t("composer.stop")}
          title={t("composer.stop")}
          disabled={working.stopping}
          onClick={working.onStop}
        >
          {working.stopping ? <span className="spinner" aria-hidden="true" /> : <StopIcon />}
        </button>
      ) : (
        <button
          type="submit"
          className="send"
          disabled={!ready}
          aria-label={working ? t("composer.sendNow") : submitLabel}
          title={working ? t("composer.sendNow") : submitLabel}
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
          {busy ? (
            <span className="spinner" aria-hidden="true" />
          ) : working ? (
            <ReturnIcon />
          ) : (
            <ArrowUpIcon />
          )}
        </button>
      )}
      {working && value.trim() && (
        <SendMenu disabled={!ready} onLater={working.onLater} onStop={working.onStop} />
      )}
    </form>
  );
}

/**
 * 发送键旁边的"⌄"：稍后排队、停止。
 */
function SendMenu({
  disabled,
  onLater,
  onStop,
}: {
  disabled: boolean;
  onLater: () => void;
  onStop: () => void;
}) {
  const t = useT();
  return (
    <PopMenu
      label={t("composer.moreSend")}
      className="send-more"
      menuClassName="send-menu"
      disabled={disabled}
      trigger={<ChevronDownIcon />}
    >
      {(pick) => (
        <>
          <MenuItem icon={<QueueIcon />} onClick={() => pick(onLater)}>
            {t("composer.later")}
          </MenuItem>
          <MenuItem icon={<StopIcon />} onClick={() => pick(onStop)}>
            {t("composer.stop")}
          </MenuItem>
        </>
      )}
    </PopMenu>
  );
}

/**
 * 输入框上的小菜单（"+"、"⌄"）：手机上照 Claude 从底部弹出，电脑上是按钮上方的小弹层。
 * children 拿到 pick：先收起菜单，再做选中的事。
 */
function PopMenu({
  label,
  className,
  menuClassName,
  trigger,
  disabled = false,
  children,
}: {
  label: string;
  className: string;
  menuClassName: string;
  trigger: ReactNode;
  disabled?: boolean;
  children: (pick: (action: () => void) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const popover = usePresence(open && !coarsePointer(), 180);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || coarsePointer()) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div className="pop-menu-wrap" ref={root}>
      <button
        type="button"
        className={`${className}${open ? " active" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {popover.mounted && (
        <div className={`popover ${menuClassName}${popover.closing ? " closing" : ""}`} role="menu">
          {children(pick)}
        </div>
      )}
      {coarsePointer() && (
        <Sheet open={open} label={label} onClose={() => setOpen(false)}>
          <div className="sheet-menu" role="menu">
            {children(pick)}
          </div>
        </Sheet>
      )}
    </div>
  );
}
