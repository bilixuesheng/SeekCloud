/**
 * 切换内容的统一动效（2026-11-07 用户在预览里定的）：
 * 旧内容滑走或往上淡出、带一点模糊，新内容带着同样的模糊滑进来、变清楚，外面的高度跟着平滑变化。
 * 样式在 styles.css 的"切换内容"一节；系统开了"减少动效"时直接换。
 */
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useClaimTouch } from "./touch";

export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 关的时候先播完动画再拿掉：open 变成 false 后，mounted 还保持 ms 毫秒。
 * shown 晚一帧才变成 true，让"从关着到开着"的过渡有起点。
 */
/**
 * 列表里的项换了位置时平滑地滑过去，不是在新位置一下子出现（FLIP）：每次渲染后量一遍带 data-flip 的元素
 * 在容器内容里的位置，和上一次比，变了就从旧位置滑到新位置。新出现的轻轻浮现。
 * 用内容坐标（加上容器的滚动量），容器滚动、抽屉滑进滑出都不算位置变了。侧栏的会话列表用：
 * 置顶、取消置顶、有动静的会话排到前面、新会话插到最上面时，别的会话跟着滑动（2026-11-15 用户要求）。
 */
export function useFlip(ref: RefObject<HTMLElement | null>): void {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top - root.scrollTop;
    const next = new Map<string, number>();
    const first = last.current.size === 0;
    for (const el of root.querySelectorAll<HTMLElement>("[data-flip]")) {
      const id = el.dataset.flip as string;
      const y = el.getBoundingClientRect().top - top;
      next.set(id, y);
      if (first || reducedMotion()) continue;
      const before = last.current.get(id);
      if (before === undefined) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: FLIP_MS,
            easing: FLIP_EASE,
          },
        );
      } else if (Math.abs(before - y) > 1) {
        el.animate([{ transform: `translateY(${before - y}px)` }, { transform: "none" }], {
          duration: FLIP_MS,
          easing: FLIP_EASE,
        });
      }
    }
    last.current = next;
  });
}

const FLIP_MS = 320;
const FLIP_EASE = "cubic-bezier(0.2, 0, 0, 1)";

export function usePresence(open: boolean, ms: number) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setShown(true));
      });
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), reducedMotion() ? 0 : ms);
    return () => clearTimeout(timer);
  }, [open, ms]);
  return { mounted, shown, closing: mounted && !open };
}

/**
 * 几页内容之间横着滑：当前页在中间，前面的页在左边、后面的页在右边，换页时滑动、淡入淡出、带一点模糊；
 * 外面的高度跟着当前页平滑变化。放在纵向 flex 里时不会被压缩（styles.css 里 flex-shrink: 0）。
 */
export function Pages({ active, children }: { active: number; children: ReactNode[] }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const [height, setHeight] = useState<number>();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const el = refs.current[active];
    if (!el) return;
    const update = () => setHeight(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);
  // 第一次量好高度之后才打开过渡，免得一出来就从 0 长高
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className={`pages${ready ? " ready" : ""}`} style={{ height }}>
      {children.map((child, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 页数固定，按位置区分
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={`page ${i === active ? "on" : i < active ? "before" : "after"}`}
          aria-hidden={i !== active}
          inert={i !== active}
        >
          {child}
        </div>
      ))}
    </div>
  );
}

/** 换字时新旧两份叠着的时长，和 styles.css 里 swap-in、swap-out 的一样。 */
const SWAP_MS = 280;

/**
 * 换字（月份、金额之类）：旧字往上淡出、模糊，新字从下面淡入、变清楚，两者叠在同一格里。
 * className 跟着每一份字走，旧字不会突然变色。思考强度的档位名不用它（用户要求直接换字）。
 */
export function SwapText({ text, className = "" }: { text: string; className?: string }) {
  const [items, setItems] = useState([{ id: 0, text, className }]);
  const next = useRef(1);
  useEffect(() => {
    setItems((list) => {
      const last = list.at(-1);
      if (last && last.text === text && last.className === className) return list;
      return [...list.slice(-1), { id: next.current++, text, className }];
    });
  }, [text, className]);
  useEffect(() => {
    if (items.length < 2) return;
    const timer = setTimeout(() => setItems((list) => list.slice(-1)), SWAP_MS);
    return () => clearTimeout(timer);
  }, [items]);
  return (
    <span className="swap">
      {items.map((item, i) => {
        const old = i < items.length - 1;
        const motion = old ? "swap-out" : items.length > 1 ? "swap-in" : "";
        return (
          <span key={item.id} className={`${item.className} ${motion}`} aria-hidden={old}>
            {item.text}
          </span>
        );
      })}
    </span>
  );
}

/** 展开收起：高度平滑变化，里面的内容同时淡入淡出、轻微模糊。 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(open ? undefined : 0);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const update = () => setHeight(open ? el.offsetHeight : 0);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);
  return (
    <div className={`collapse${open ? " open" : ""}`} style={{ height }} inert={!open}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

/** 底部弹层开和关的时长，和 styles.css 里 --sheet-ms 的一样。 */
export const SHEET_MS = 360;

/**
 * 拖动条松手时关不关：往下拉过 90 像素，或者往下甩得够快（每毫秒 0.5 像素以上）就关，不然弹回去。
 * 只拉了几个像素就松手不算甩，免得手抖一下就关了。
 */
export function sheetShouldClose(dragged: number, velocity: number): boolean {
  return dragged > 90 || (dragged > 12 && velocity > 0.5);
}

/**
 * 底部弹层：从屏幕底下滑上来，关的时候按原路滑回去，同样的曲线和时长，遮罩一起淡入淡出。
 * 拖动条能往下拉关掉。从一个菜单进到另一个弹层时，先关这一个，在 onClosed 里再打开下一个，
 * 这样是先收下去、再弹出来。
 */
export function Sheet({
  open,
  label,
  onClose,
  onClosed,
  children,
}: {
  open: boolean;
  label: string;
  onClose: () => void;
  /** 关的动画播完、弹层拿掉以后。 */
  onClosed?: () => void;
  children: ReactNode;
}) {
  const { mounted, shown } = usePresence(open, SHEET_MS);
  const [dragged, setDragged] = useState<number>();
  const drag = useRef<{ start: number; last: number; at: number; velocity: number }>(undefined);
  const wasMounted = useRef(mounted);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  // 拖动条上的手指归弹层，不让 App 的手势抢走（touch.ts）
  const grip = useRef<HTMLDivElement>(null);
  useClaimTouch(grip, mounted);

  useEffect(() => {
    if (wasMounted.current && !mounted) closed.current?.();
    wasMounted.current = mounted;
  }, [mounted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const onDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: e.clientY, last: e.clientY, at: e.timeStamp, velocity: 0 };
    setDragged(0);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = e.timeStamp - d.at;
    if (dt > 0) d.velocity = (e.clientY - d.last) / dt;
    d.last = e.clientY;
    d.at = e.timeStamp;
    setDragged(Math.max(0, e.clientY - d.start));
  };
  const onUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = undefined;
    setDragged(undefined);
    if (sheetShouldClose(d.last - d.start, d.velocity)) onClose();
  };

  const visible = shown && open;
  // 挂到页面最外层：在侧栏这类有位移、有裁切的容器里打开时，弹层照样贴着屏幕底部、盖在最上面
  return createPortal(
    <>
      <div
        className={`sheet-scrim${visible ? " shown" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <section
        className={`sheet${visible ? " shown" : ""}${dragged !== undefined ? " dragging" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={dragged ? { transform: `translateY(${dragged}px)` } : undefined}
      >
        <div
          ref={grip}
          className="sheet-drag"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <div className="sheet-grip" />
        </div>
        {children}
      </section>
    </>,
    document.body,
  );
}
