import { type ReactNode, useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "../Icons";
import { usePresence } from "../Motion";

export interface Option {
  value: string;
  text: string;
}

/** 选项多于这么多时，弹层顶上有搜索框。 */
const SEARCH_AFTER = 8;

/**
 * 输入框下面的选择（环境、基础分支）：按钮上只显示选中的那一项，点开是自己画的弹层，
 * 不用浏览器自带的下拉框（手机上那是系统的选择器，和别的弹层不是一个样子）。
 * 弹层相对整行定位（.composer-below），手机上往上开、和行一样宽，不会被横着滑的那一行裁掉。
 */
export function OptionPicker({
  icon,
  label,
  value,
  options,
  onChange,
  onOpen,
  emptyText = "未找到匹配的选项。",
}: {
  icon: ReactNode;
  /** 弹层的标题，也是读屏软件读的名字。 */
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  /** 打开时（让别的弹层收起来）。 */
  onOpen?: () => void;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = usePresence(open, 180);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = options.find((o) => o.value === value)?.text ?? value;
  const searchable = options.length > SEARCH_AFTER;
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.text.toLowerCase().includes(q)) : options;

  // 点外面或按 Esc 收起
  useEffect(() => {
    if (!open) return;
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

  // 有搜索框时打开就能直接打字；关掉以后清空
  useEffect(() => {
    if (open) search.current?.focus({ preventScroll: true });
    else setQuery("");
  }, [open]);

  const toggle = () => {
    if (!open) onOpen?.();
    setOpen(!open);
  };

  return (
    <div className="option-chip" ref={root}>
      <button
        type="button"
        className={`chip${open ? " active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}：${current}`}
        onClick={toggle}
      >
        {icon}
        <span className="chip-text">{current}</span>
        <ChevronDownIcon />
      </button>
      {mounted && (
        <div
          className={`popover option-picker${closing ? " closing" : ""}`}
          role="dialog"
          aria-label={label}
        >
          <p className="option-picker-label">{label}</p>
          {searchable && (
            <input
              ref={search}
              className="popover-search"
              type="search"
              placeholder="搜索"
              aria-label={`搜索${label}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {shown.length === 0 ? (
            <p className="popover-empty">{emptyText}</p>
          ) : (
            <ul className="option-list">
              {shown.map((o) => {
                const selected = o.value === value;
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      className={`option${selected ? " selected" : ""}`}
                      aria-pressed={selected}
                      onClick={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                    >
                      <span className="option-text">{o.text}</span>
                      {selected && <CheckIcon />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
