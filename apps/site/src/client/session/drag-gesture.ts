/**
 * 侧栏拖动的判定（#153），都是纯函数，界面在 useSidebarDrag.ts。
 *
 * - 手机（手指、笔）：按下以后先看往哪边走。先竖着走就是滚动（交给浏览器，到松手都不变成拖动）；
 *   先横着走一段（约 10 像素，横向明显大于竖向）：在会话上往右是拖动，往左是把全屏的侧栏拖回去。
 * - 电脑（鼠标）：按住一动（超过 4 像素）就是拖动。
 */

export type PointerKind = "mouse" | "touch" | "pen";
export type Gesture = "pending" | "scroll" | "drag" | "swipe-close";

/** 手指走多远开始判方向。 */
export const DIRECTION_SLOP = 10;
/** 鼠标走多远算开始拖。 */
export const MOUSE_SLOP = 4;

export function classifyGesture(
  dx: number,
  dy: number,
  pointer: PointerKind,
  options: { onSession: boolean; canSwipeClose: boolean },
): Gesture {
  if (pointer === "mouse") {
    return options.onSession && Math.hypot(dx, dy) > MOUSE_SLOP ? "drag" : "pending";
  }
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < DIRECTION_SLOP) return "pending";
  // 横向要明显大于竖向，斜着走算滚动
  if (ax < DIRECTION_SLOP || ax <= ay * 1.5) return "scroll";
  if (dx > 0) return options.onSession ? "drag" : "scroll";
  return options.canSwipeClose ? "swipe-close" : options.onSession ? "drag" : "scroll";
}

/** 松手时全屏的侧栏收不收：拖过一半，或者往左甩得够快（每毫秒 0.5 像素以上）。 */
export function shouldClose(dx: number, velocity: number, width: number): boolean {
  return dx < -width / 2 || velocity < -0.5;
}

/** 拖动时侧栏跟着手指横向动，越往外越吃力（橡皮筋），最多挪 max。 */
export function rubberBand(dx: number, max = 48): number {
  const sign = Math.sign(dx);
  const d = Math.abs(dx);
  return sign * max * (1 - 1 / (d / max + 1));
}

/** 能放下的一块：置顶、某个分组、最近、新分组。items 是这一块里的会话（不含正在拖的），从上到下。 */
export interface DropZone {
  id: string;
  top: number;
  bottom: number;
  /** 浮在上面的（新分组）：手指在它的范围里就算它，盖过下面的分组。 */
  floating?: boolean;
  items: Array<{ shortId: string; top: number; bottom: number }>;
}

export interface DropTarget {
  zone: string;
  /** 放下以后挨在上面的那个会话；null 是这一块的最上面。 */
  after: string | null;
  /** 插入线画在哪里（页面坐标）。 */
  lineY: number;
}

/**
 * 手指在 y 时放到哪里：先看浮着的块，再看手指在哪一块的上下范围里；都不在时取最近的一块。
 * 块里按会话的中线算：手指过了哪个会话的中线，就放在它下面。
 */
export function dropTarget(zones: DropZone[], y: number): DropTarget | undefined {
  const floating = zones.find((z) => z.floating && y >= z.top && y <= z.bottom);
  if (floating) return { zone: floating.id, after: null, lineY: floating.top };
  const regular = zones.filter((z) => !z.floating);
  if (regular.length === 0) return undefined;
  const zone =
    regular.find((z) => y >= z.top && y <= z.bottom) ??
    [...regular].sort(
      (a, b) =>
        Math.min(Math.abs(y - a.top), Math.abs(y - a.bottom)) -
        Math.min(Math.abs(y - b.top), Math.abs(y - b.bottom)),
    )[0];
  if (!zone) return undefined;
  let after: string | null = null;
  let lineY = zone.items[0]?.top ?? zone.top;
  for (const item of zone.items) {
    if (y > (item.top + item.bottom) / 2) {
      after = item.shortId;
      lineY = item.bottom;
    }
  }
  return { zone: zone.id, after, lineY };
}

/** 离列表上下边多近开始自己滚，每帧最多滚多少。 */
export function autoScrollSpeed(y: number, top: number, bottom: number, edge = 48, max = 14) {
  if (y < top + edge) return -max * Math.min(1, (top + edge - y) / edge);
  if (y > bottom - edge) return max * Math.min(1, (y - (bottom - edge)) / edge);
  return 0;
}
