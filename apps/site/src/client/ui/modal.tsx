import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "../Icons";
import { usePresence } from "../Motion";

/**
 * 弹窗（2026-11-22 用户要求）：要填东西的操作（改密码、开关两步验证、添加通行密钥、编辑模型这些）放在弹窗里做，
 * 不在卡片里展开。和确认弹窗一样的进出：背景变暗、轻微模糊，窗口带着模糊浮现、缩放到位，关的时候反着来。
 * Esc、点背景、右上角的 × 都是关；关的时候焦点回到打开它的按钮上。
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 内容多的（模型目录）用宽一点的。 */
  wide?: boolean;
}) {
  const { mounted, closing } = usePresence(open, 220);
  const card = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    // 光标放进第一个输入框；没有输入框就放在窗口上
    const first = card.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]):not([hidden]), select, textarea",
    );
    (first ?? card.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      // 下拉框开着时 Esc 先收起下拉框（ui/select.tsx 自己处理），弹窗不关
      if (e.key === "Escape" && !document.querySelector(".select-list:not(.closing)")) {
        // 捕获阶段先拿到：不让底下的设置窗口跟着关
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      restoreFocus.current?.focus?.();
    };
  }, [open]);

  if (!mounted || typeof document === "undefined") return null;
  return createPortal(
    <div
      className={`confirm-backdrop${closing ? " closing" : ""}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={card}
        className={`confirm-dialog modal${wide ? " wide" : ""}${closing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="toast-close" aria-label="关闭" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
