import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "../Icons";
import { usePresence } from "../Motion";

/**
 * 自己画的下拉框（2026-11-22 用户要求设置里不要用浏览器自带的下拉框）：按钮和输入框一个样子，点开是带模糊
 * 浮现的列表，当前那项打勾；可以分组（比如按提供方）、每项可以带一行说明。键盘：上下方向键挑、回车选、Esc 收起。
 */

export interface SelectOption {
  value: string;
  label: string;
  /** 选项下面的一行小字。 */
  hint?: string;
  /** 分组的名字：相邻同组的放在一个标题下面。 */
  group?: string;
}

export function Select({
  value,
  options,
  onChange,
  label,
  disabled = false,
  size = "normal",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** 读屏软件读的名字。 */
  label: string;
  disabled?: boolean;
  /** small：一行里的小号（推理等级的参数这类）。 */
  size?: "normal" | "small";
}) {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = usePresence(open, 180);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  // 列表挂在 body 上、按按钮的位置摆：放在弹窗的滚动区里也不会被裁掉；下面放不下就往上开
  const [place, setPlace] = useState<CSSProperties>();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    // 外面滚动、窗口变了大小：位置不对了，收起来
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, options, value]);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const up = below < 240 && rect.top > below;
    const width = Math.max(rect.width, size === "small" ? 180 : 0);
    const left = Math.min(rect.left, window.innerWidth - width - 8);
    setPlace({
      position: "fixed",
      left,
      width,
      maxHeight: Math.min(300, (up ? rect.top : below) - 16),
      ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      transformOrigin: up ? "bottom center" : "top center",
    });
  }, [open, size]);

  // 键盘挑到的那项滚进视野
  useEffect(() => {
    if (!open || active < 0) return;
    root.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const choose = (next: string) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      // 只收起列表，不让外面的弹窗跟着关
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const option = options[active];
      if (option) choose(option.value);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={root} className={`select${size === "small" ? " small" : ""}`}>
      <button
        type="button"
        className={`select-button${open ? " open" : ""}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onClick={() => setOpen(!open)}
      >
        <span className="select-value">{current?.label ?? value}</span>
        <span className="select-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>
      {mounted &&
        place &&
        createPortal(
          <div
            ref={list}
            id={listId}
            className={`select-list${closing ? " closing" : ""}`}
            style={place}
            role="listbox"
            aria-label={label}
          >
            {options.map((o, i) => (
              <div key={o.value} role="presentation">
                {o.group && o.group !== options[i - 1]?.group && (
                  <div className="select-group">{o.group}</div>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={o.value === value}
                  data-index={i}
                  className={`select-option${i === active ? " active" : ""}`}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(o.value)}
                  onKeyDown={() => undefined}
                >
                  <span className="select-option-text">
                    <span>{o.label}</span>
                    {o.hint && <span className="select-option-hint">{o.hint}</span>}
                  </span>
                  {o.value === value && <CheckIcon />}
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
