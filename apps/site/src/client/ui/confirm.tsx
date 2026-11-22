import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 确认弹窗（2026-11-22 用户要求）：退出登录、删除这类要再确认一次的操作，弹出一个窗口问，不在原地把按钮换成
 * "确认"。背景变暗、轻微模糊，窗口带着模糊浮现、缩放到位；关的时候反着来。Esc、点背景都是取消。
 * 在哪里都能 await confirmDialog({...})；ConfirmHost 挂在 mountApp 里。
 */

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 删除、退出这类：确认按钮是红的。 */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

const CLOSE_MS = 220;
let show: ((pending: Pending) => void) | undefined;
let nextId = 1;

/** 弹出确认窗口：点了确认是 true，取消、Esc、点背景是 false。ConfirmHost 还没挂上时直接返回 false。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(false);
    show({ ...options, id: nextId++, resolve });
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending>();
  const [closing, setClosing] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    show = (next) => {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      setClosing(false);
      setPending((current) => {
        // 上一个还开着又来一个：上一个算取消
        current?.resolve(false);
        return next;
      });
    };
    return () => {
      show = undefined;
    };
  }, []);

  const close = (ok: boolean) => {
    if (!pending || closing) return;
    pending.resolve(ok);
    setClosing(true);
    setTimeout(() => {
      setPending(undefined);
      setClosing(false);
      restoreFocus.current?.focus?.();
    }, CLOSE_MS);
  };

  useEffect(() => {
    if (!pending) return;
    confirmButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(false);
      }
    };
    // 捕获阶段先拿到 Esc：不让底下的设置窗口跟着关
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!pending || typeof document === "undefined") return null;
  return createPortal(
    <div
      className={`confirm-backdrop${closing ? " closing" : ""}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div
        className={`confirm-dialog${closing ? " closing" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`confirm-title-${pending.id}`}
        onKeyDown={(e) => {
          // Tab 只在两个按钮之间转，不跑到底下的页面上
          if (e.key !== "Tab") return;
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
          e.preventDefault();
          next?.focus();
        }}
      >
        <h2 id={`confirm-title-${pending.id}`}>{pending.title}</h2>
        {pending.body && <div className="confirm-body">{pending.body}</div>}
        <div className="confirm-actions">
          <button type="button" className="secondary" onClick={() => close(false)}>
            {pending.cancelText ?? "取消"}
          </button>
          <button
            ref={confirmButton}
            type="button"
            className={pending.danger ? "primary danger" : "primary"}
            onClick={() => close(true)}
          >
            {pending.confirmText ?? "确定"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
