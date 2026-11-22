import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api";
import {
  autoScrollSpeed,
  classifyGesture,
  type DropTarget,
  type DropZone,
  dropTarget,
  type PointerKind,
  rubberBand,
  shouldClose,
} from "./drag-gesture";
import type { Session } from "./types";

/**
 * 侧栏的拖动（#153）。判定规则在 drag-gesture.ts；这里接指针事件、画浮起来的会话和插入线、
 * 靠近上下边时自己滚、松手时调放置的接口。
 *
 * 列表上要有的标记：会话的 <li data-session="短ID">（已归档的加 data-archived，不能拖），
 * 能放下的块 data-drop="pinned" | "group:<id>" | "recent" | "new-group"（浮着的加 data-floating，
 * 折叠着的加 data-collapsed）。列表要 touch-action: pan-y：先竖着走的由浏览器滚动。
 */

export interface DragState {
  shortId: string;
  title: string;
  repo: string;
  /** 从置顶里拖出来的：拖到别处时手指旁边提示"松手取消置顶"。 */
  fromPinned: boolean;
  x: number;
  y: number;
  target: DropTarget | undefined;
}

interface Pending {
  id: number;
  kind: PointerKind;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  velocity: number;
  session?: Session;
  mode: "pending" | "drag" | "swipe-close";
}

export function useSidebarDrag(options: {
  list: RefObject<HTMLElement | null>;
  sidebar: RefObject<HTMLElement | null>;
  sessions: Session[];
  /** 侧栏铺满整屏（手机上打开着）：往左滑能把它拖回去。 */
  fullScreen: boolean;
  onClose: () => void;
  upsert: (session: Session) => void;
  /** 拖到"新分组"上建好了分组：让它的名字马上能改。 */
  onGroupCreated: (groupId: string) => void;
  onError: (message: string) => void;
}) {
  const [drag, setDrag] = useState<DragState>();
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<Pending | undefined>(undefined);
  const scrollFrame = useRef(0);
  const suppressClick = useRef(0);

  const sidebarStyle = useCallback((transform: string, animate: boolean) => {
    const el = latest.current.sidebar.current;
    if (!el) return;
    el.style.transition = animate ? "transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2)" : "none";
    el.style.transform = transform;
    if (animate) {
      const reset = () => {
        el.style.transition = "";
        el.style.transform = "";
        el.removeEventListener("transitionend", reset);
      };
      el.addEventListener("transitionend", reset);
      setTimeout(reset, 400);
    }
  }, []);

  /** 现在列表里能放下的块和它们的会话（不含正在拖的），页面坐标。 */
  const zones = useCallback((exclude: string): DropZone[] => {
    const list = latest.current.list.current;
    const root = list?.closest("aside") ?? list;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>("[data-drop]")].map((el) => {
      const rect = el.getBoundingClientRect();
      const collapsed = el.hasAttribute("data-collapsed");
      return {
        id: el.dataset.drop as string,
        top: rect.top,
        bottom: rect.bottom,
        floating: el.hasAttribute("data-floating"),
        items: collapsed
          ? []
          : [...el.querySelectorAll<HTMLElement>("li[data-session]")]
              .filter((li) => li.dataset.session !== exclude)
              .map((li) => {
                const r = li.getBoundingClientRect();
                return { shortId: li.dataset.session as string, top: r.top, bottom: r.bottom };
              }),
      };
    });
  }, []);

  const finishDrag = useCallback(
    async (state: DragState | undefined) => {
      cancelAnimationFrame(scrollFrame.current);
      setDrag(undefined);
      sidebarStyle("translateX(0)", true);
      if (!state?.target) return;
      const { zone, after } = state.target;
      const { upsert, onGroupCreated, onError } = latest.current;
      try {
        let groupId: string | undefined;
        let section: string;
        if (zone === "new-group") {
          const group = await api<{ id: string }>("/api/session-groups", { name: "新分组" });
          groupId = group.id;
          section = "group";
          onGroupCreated(group.id);
        } else if (zone.startsWith("group:")) {
          groupId = zone.slice("group:".length);
          section = "group";
        } else {
          section = zone;
        }
        const session = await api<Session>(`/api/sessions/${state.shortId}/place`, {
          section,
          ...(groupId ? { groupId } : {}),
          after: zone === "new-group" ? null : after,
        });
        upsert(session);
      } catch (e) {
        onError((e as ApiError).message);
      }
    },
    [sidebarStyle],
  );

  useEffect(() => {
    const list = options.list.current;
    if (!list) return;
    let current: DragState | undefined;

    const update = (x: number, y: number) => {
      if (!current) return;
      current = { ...current, x, y, target: dropTarget(zones(current.shortId), y) };
      setDrag(current);
    };

    const scrollLoop = () => {
      if (!current) return;
      const rect = list.getBoundingClientRect();
      const speed = autoScrollSpeed(current.y, rect.top, rect.bottom);
      if (speed !== 0) {
        list.scrollTop += speed;
        update(current.x, current.y);
      }
      scrollFrame.current = requestAnimationFrame(scrollLoop);
    };

    const onMove = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.id) return;
      const now = performance.now();
      p.velocity = (e.clientX - p.lastX) / Math.max(1, now - p.lastT);
      p.lastX = e.clientX;
      p.lastT = now;
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      if (p.mode === "pending") {
        const gesture = classifyGesture(dx, dy, p.kind, {
          onSession: Boolean(p.session && p.session.status !== "archived"),
          canSwipeClose: latest.current.fullScreen && p.kind !== "mouse",
        });
        if (gesture === "pending") return;
        if (gesture === "scroll") {
          pending.current = undefined;
          return;
        }
        p.mode = gesture;
        if (gesture === "drag" && p.session) {
          const s = p.session;
          current = {
            shortId: s.shortId,
            title: s.title,
            repo: s.repos[0]?.fullName ?? "",
            fromPinned: s.pinnedAt !== null,
            x: e.clientX,
            y: e.clientY,
            target: undefined,
          };
          setDrag(current);
          // 先让"拖到这里"和"新分组"画出来，再算放到哪里
          requestAnimationFrame(() => current && update(e.clientX, e.clientY));
          scrollFrame.current = requestAnimationFrame(scrollLoop);
        }
      }
      if (p.mode === "swipe-close") {
        sidebarStyle(`translateX(${Math.min(0, dx)}px)`, false);
        return;
      }
      if (p.mode === "drag") {
        e.preventDefault();
        if (p.kind !== "mouse" && latest.current.fullScreen) {
          sidebarStyle(`translateX(${rubberBand(dx)}px)`, false);
        }
        update(e.clientX, e.clientY);
      }
    };

    const end = (e: PointerEvent, cancelled: boolean) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.id) return;
      pending.current = undefined;
      window.removeEventListener("pointermove", onMove);
      if (p.mode === "swipe-close") {
        const width = latest.current.sidebar.current?.offsetWidth ?? window.innerWidth;
        if (!cancelled && shouldClose(e.clientX - p.startX, p.velocity, width)) {
          const el = latest.current.sidebar.current;
          if (el) {
            el.style.transition = "";
            el.style.transform = "";
          }
          latest.current.onClose();
        } else {
          sidebarStyle("translateX(0)", true);
        }
        suppressClick.current = performance.now();
        return;
      }
      if (p.mode === "drag") {
        suppressClick.current = performance.now();
        const state = current;
        current = undefined;
        void finishDrag(cancelled ? undefined : state);
      }
    };
    const onUp = (e: PointerEvent) => end(e, false);
    const onCancel = (e: PointerEvent) => end(e, true);

    const onDown = (e: PointerEvent) => {
      if (pending.current || (e.pointerType === "mouse" && e.button !== 0)) return;
      const target = e.target as HTMLElement;
      // "⋯"、折叠按钮、输入框这些照常点
      if (target.closest("button, input, textarea")) return;
      const li = target.closest<HTMLElement>("li[data-session]");
      const session = li
        ? latest.current.sessions.find((s) => s.shortId === li.dataset.session)
        : undefined;
      pending.current = {
        id: e.pointerId,
        kind: (e.pointerType as PointerKind) || "mouse",
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastT: performance.now(),
        velocity: 0,
        session,
        mode: "pending",
      };
      window.addEventListener("pointermove", onMove, { passive: false });
    };

    // 拖完、滑完松手时浏览器还会补一个点击：吞掉，不打开会话
    const onClick = (e: MouseEvent) => {
      if (performance.now() - suppressClick.current < 400) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && current) {
        current = undefined;
        pending.current = undefined;
        void finishDrag(undefined);
      }
    };
    // 链接自己的拖动（拖出网址）不要
    const onDragStart = (e: DragEvent) => e.preventDefault();

    const root = list.closest("aside") ?? list;
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("click", onClick, true);
    root.addEventListener("dragstart", onDragStart);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(scrollFrame.current);
    };
  }, [options.list, zones, finishDrag, sidebarStyle]);

  return drag;
}
