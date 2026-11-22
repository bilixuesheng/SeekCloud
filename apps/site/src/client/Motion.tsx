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
    const top = layoutTop(root);
    const next = new Map<string, number>();
    const first = last.current.size === 0;
    for (const el of root.querySelectorAll<HTMLElement>("[data-flip]")) {
      const id = el.dataset.flip as string;
      // 量排版上的位置（不算正在播的动画的位移）：动画播到一半又渲染时（比如拖动时每动一下都渲染），
      // 量到的位置带着上一段动画的位移，会一段比一段大，越滑越远
      const y = layoutTop(el) - top;
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

/** 元素在页面里排版上的上边（offsetTop 一路加上去）：不受 transform 和滚动的影响。 */
function layoutTop(el: HTMLElement): number {
  let y = 0;
  for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) {
    y += node.offsetTop;
  }
  return y;
}

/**
 * 一行字带着轻微的模糊一个个浮现出来（照 Claude 置顶消息的标题，2026-11-15 用户要求）：每个字从模糊、透明
 * 变清楚，从左往右错开。挂上时播一次；字变了（比如标题生成好了）就换一组重新播。减少动效时直接显示。
 */
export function BlurText({ text, step = 30 }: { text: string; step?: number }) {
  return (
    <span className="blur-text" key={text}>
      {/* 读屏软件读整句，不一个个字地读 */}
      <span className="visually-hidden">{text}</span>
      {[...text].map((char, i) => (
        // 每个字一组动画，内容不会重排，用位置当 key
        // biome-ignore lint/suspicious/noArrayIndexKey: 见上
        <span key={i} aria-hidden="true" style={{ animationDelay: `${i * step}ms` }}>
          {char}
        </span>
      ))}
    </span>
  );
}
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

/** 底部弹层打开的时长：先快后慢地停下。 */
export const SHEET_MS = 360;
/** 关的时长：先慢后快地滑出去（不在快到底时放慢，免得看着像停在半路）。 */
export const SHEET_CLOSE_MS = 260;
const SHEET_OPEN_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const SHEET_CLOSE_EASE = "cubic-bezier(0.3, 0, 0.8, 0.15)";
/** 关的时候滑到弹层下面这么多：弹层上沿的阴影也滑出屏幕。 */
const SHEET_SHADOW_PX = 48;

/**
 * 拖动条松手时关不关：往下拉过 90 像素，或者往下甩得够快（每毫秒 0.5 像素以上）就关，不然弹回去。
 * 只拉了几个像素就松手不算甩，免得手抖一下就关了。
 */
export function sheetShouldClose(dragged: number, velocity: number): boolean {
  return dragged > 90 || (dragged > 12 && velocity > 0.5);
}

/** 弹层现在往下挪了多少像素（正在播的动画、拖动的位移都算）。 */
function sheetOffset(el: HTMLElement): number {
  const transform = getComputedStyle(el).transform;
  return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
}

/**
 * 弹层滑到 to（0 是停在原位，"out" 是滑出屏幕，连上沿的阴影一起），从 from 开始（不给就从现在的位置），
 * 遮罩跟着淡入淡出。先停掉还在播的动画（关到一半又打开时从当前位置接着走）。返回弹层的那段动画。
 */
function slideSheet(
  el: HTMLElement | null,
  bg: HTMLElement | null,
  playing: Animation[],
  to: 0 | "out",
  from: number | undefined,
  setPlaying: (list: Animation[]) => void,
): Animation | undefined {
  if (!el || !bg) return undefined;
  const startY = from ?? sheetOffset(el);
  const startOpacity = Number(getComputedStyle(bg).opacity);
  for (const a of playing) a.cancel();
  // 滑出去：滑过弹层自己的高度加上阴影。滑上来的路程按一整屏算（打开的那一刻里面的内容可能还没量好高度，
  // 弹层自己的高度还不准）
  const outY =
    to === "out"
      ? el.offsetHeight + SHEET_SHADOW_PX
      : Math.max(el.offsetHeight, window.innerHeight) + SHEET_SHADOW_PX;
  const endY = to === "out" ? outY : 0;
  const full = to === "out" ? SHEET_CLOSE_MS : SHEET_MS;
  // 走的路短（拖到一半松手）就快一点
  const duration = reducedMotion() ? 0 : Math.max(120, (full * Math.abs(endY - startY)) / outY);
  const easing = to === "out" ? SHEET_CLOSE_EASE : SHEET_OPEN_EASE;
  const options = { duration, easing, fill: "forwards" as const };
  const moving = el.animate(
    [{ transform: `translateY(${startY}px)` }, { transform: `translateY(${endY}px)` }],
    options,
  );
  const fading = bg.animate(
    [{ opacity: startOpacity }, { opacity: to === "out" ? 0 : 1 }],
    options,
  );
  setPlaying([moving, fading]);
  return moving;
}

/**
 * 底部弹层：从屏幕底下滑上来，遮罩一起淡入；关的时候滑出屏幕、遮罩淡出，滑到底以后才拿掉。
 * 拖动条能往下拉关掉。从一个菜单进到另一个弹层时，先关这一个，在 onClosed 里再打开下一个，
 * 这样是先收下去、再弹出来。
 *
 * 动画用 Web Animations 播（不靠 CSS 过渡）：打开的起点是写明的"在屏幕下面"，不靠浏览器先算出隐藏时的
 * 样式，所以每次都有动画；关的时候从现在的位置（包括拖到一半、开到一半）接着滑，播完才拿掉，
 * 不会在半路停住再一下子消失。系统开了"减少动效"时直接出现、直接拿掉。
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
  const [mounted, setMounted] = useState(open);
  // 打开时和 open 同一次渲染就挂上，不等下一轮
  if (open && !mounted) setMounted(true);
  const [dragged, setDragged] = useState<number>();
  const drag = useRef<{ start: number; last: number; at: number; velocity: number }>(undefined);
  const sheet = useRef<HTMLElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const playing = useRef<Animation[]>([]);
  /** 拖动条松手关掉时，弹层停在哪（松手那一下拖动的位移已经清掉了，关的动画从这里接着走）。 */
  const releasedAt = useRef<number | undefined>(undefined);
  const wasMounted = useRef(mounted);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  // 拖动条上的手指归弹层，不让 App 的手势抢走（touch.ts）
  const grip = useRef<HTMLDivElement>(null);
  useClaimTouch(grip, mounted);

  const slide = (to: 0 | "out", from?: number) =>
    slideSheet(sheet.current, scrim.current, playing.current, to, from, (list) => {
      playing.current = list;
    });

  // 打开：从屏幕下面（或者关到一半的地方）滑上来。关：从现在的位置滑出去，播完才拿掉。
  // 在画出来之前开始动画，第一帧就是起点，不会先闪一下停在原位的样子。
  useLayoutEffect(() => {
    if (!mounted) return;
    const el = sheet.current;
    if (!el) return;
    const setPlaying = (list: Animation[]) => {
      playing.current = list;
    };
    if (open) {
      const fresh = playing.current.length === 0;
      const moving = slideSheet(
        el,
        scrim.current,
        playing.current,
        0,
        // 第一次打开从一整屏下面开始：这时里面的内容可能还没量好高度
        fresh ? window.innerHeight + SHEET_SHADOW_PX : undefined,
        setPlaying,
      );
      // 停稳以后去掉动画留下的样式，拖动时直接改位置
      void moving?.finished.then(
        () => {
          for (const a of playing.current) a.cancel();
          playing.current = [];
        },
        () => undefined,
      );
      return;
    }
    const moving = slideSheet(
      el,
      scrim.current,
      playing.current,
      "out",
      releasedAt.current,
      setPlaying,
    );
    releasedAt.current = undefined;
    let done = false;
    const unmount = () => {
      if (done) return;
      done = true;
      playing.current = [];
      setMounted(false);
    };
    void moving?.finished.then(unmount, () => undefined);
    // 万一动画没播（页面在后台、浏览器不支持），也按时拿掉
    const timer = setTimeout(unmount, (reducedMotion() ? 0 : SHEET_CLOSE_MS) + 200);
    return () => clearTimeout(timer);
  }, [open, mounted]);

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
    if (!open) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // 还在滑上来时就拉住：停在现在的位置，跟着手指
    const el = sheet.current;
    const at = el ? Math.max(0, sheetOffset(el)) : 0;
    for (const a of playing.current) a.cancel();
    playing.current = [];
    drag.current = { start: e.clientY - at, last: e.clientY, at: e.timeStamp, velocity: 0 };
    setDragged(at);
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
    const offset = Math.max(0, d.last - d.start);
    setDragged(undefined);
    if (sheetShouldClose(offset, d.velocity)) {
      releasedAt.current = offset;
      onClose();
    } else {
      // 弹回去
      slide(0, offset);
    }
  };

  // 挂到页面最外层：在侧栏这类有位移、有裁切的容器里打开时，弹层照样贴着屏幕底部、盖在最上面
  return createPortal(
    <>
      <div ref={scrim} className="sheet-scrim" onClick={onClose} aria-hidden="true" />
      <section
        ref={sheet}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={dragged !== undefined ? { transform: `translateY(${dragged}px)` } : undefined}
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
