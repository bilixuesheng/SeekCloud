import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CloseIcon, WarningIcon } from "../Icons";

/**
 * 通知（2026-11-22 用户要求）：操作的结果不直接插在页面里，在右下角弹出一条（手机上在底部），可以堆叠，
 * 几秒后自己收起；指着的时候不收。进来时带着模糊浮上来，走的时候模糊淡出、下面的往下合拢。
 * 在哪里都能调 toast()；ToastHost 挂在 mountApp 里。
 */

export type ToastTone = "success" | "error" | "info";

interface Item {
  id: number;
  tone: ToastTone;
  text: string;
  leaving: boolean;
}

/** 最多同时显示几条：多了先收最早的。 */
const MAX_VISIBLE = 4;
const LEAVE_MS = 260;

let items: Item[] = [];
let nextId = 1;
const listeners = new Set<(items: Item[]) => void>();
const timers = new Map<
  number,
  { timer: ReturnType<typeof setTimeout>; left: number; at: number }
>();

function publish() {
  for (const listener of listeners) listener(items);
}

function schedule(id: number, ms: number) {
  const timer = setTimeout(() => dismissToast(id), ms);
  timers.set(id, { timer, left: ms, at: Date.now() });
}

/** 弹出一条通知。出错的多停一会儿。返回它的 ID，可以提前收起。 */
export function toast(text: string, tone: ToastTone = "success"): number {
  const id = nextId++;
  items = [...items, { id, tone, text, leaving: false }];
  const visible = items.filter((i) => !i.leaving);
  if (visible.length > MAX_VISIBLE) dismissToast((visible[0] as Item).id);
  publish();
  schedule(id, tone === "error" ? 7000 : 4000);
  return id;
}

export function dismissToast(id: number): void {
  const found = timers.get(id);
  if (found) clearTimeout(found.timer);
  timers.delete(id);
  if (!items.some((i) => i.id === id && !i.leaving)) return;
  items = items.map((i) => (i.id === id ? { ...i, leaving: true } : i));
  publish();
  setTimeout(() => {
    items = items.filter((i) => i.id !== id);
    publish();
  }, LEAVE_MS);
}

/** 指着通知时不收：剩下的时间记着，移开再接着算。 */
function pauseAll() {
  for (const [id, t] of timers) {
    clearTimeout(t.timer);
    timers.set(id, { ...t, left: Math.max(1000, t.left - (Date.now() - t.at)) });
  }
}

function resumeAll() {
  for (const [id, t] of timers) schedule(id, t.left);
}

export function ToastHost() {
  const [list, setList] = useState(items);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listeners.add(setList);
    setList(items);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    // 读屏软件读出新来的通知
    <div
      ref={host}
      className="toast-stack"
      aria-live="polite"
      onPointerEnter={pauseAll}
      onPointerLeave={resumeAll}
    >
      {list.map((item) => (
        <div key={item.id} className={`toast-slot${item.leaving ? " leaving" : ""}`}>
          <div className={`toast ${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>
            <span className="toast-icon" aria-hidden="true">
              {item.tone === "error" ? (
                <WarningIcon />
              ) : item.tone === "success" ? (
                <CheckIcon />
              ) : null}
            </span>
            <span className="toast-text">{item.text}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="关闭通知"
              onClick={() => dismissToast(item.id)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** 出错的说明（读取或者操作失败）变了就弹一条出错的通知，不插在页面里。 */
export function useErrorToast(error: string | undefined | null): void {
  useEffect(() => {
    if (error) toast(error, "error");
  }, [error]);
}
