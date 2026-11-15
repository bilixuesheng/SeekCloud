import { type RefObject, useEffect } from "react";

/**
 * 在这个元素上按下、拖动的手指归它自己：滑块、底部弹层的拖动条用。
 * 光有 CSS 的 touch-action: none 不够：页面放在 App 里（比如安卓 App 的网页视图）时，
 * App 自己的手势（横滑切换、下拉关闭）会先把横着或竖着的拖动抢走，网页这边只收到取消，
 * 滑块就拖不动。在触摸事件上 preventDefault（要非被动的监听，React 的 onTouchMove 是被动的）
 * 才会告诉外面"这次触摸网页用了"。我们用的是 pointer 事件，不受影响。
 */
export function useClaimTouch(
  ref: RefObject<HTMLElement | null>,
  /** 元素挂上以后才有用（比如弹层打开时），挂上、拿掉时跟着变。 */
  mounted = true,
): void {
  useEffect(() => {
    if (!mounted) return;
    const el = ref.current;
    if (!el) return;
    const claim = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", claim, { passive: false });
    el.addEventListener("touchmove", claim, { passive: false });
    return () => {
      el.removeEventListener("touchstart", claim);
      el.removeEventListener("touchmove", claim);
    };
  }, [ref, mounted]);
}
