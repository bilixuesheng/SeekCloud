/**
 * 手机的输入法开着没有。浏览器没有直接告诉网页的办法，这里看可见区域的高度：
 * 比同一宽度下见过的最高时矮了一截，就当输入法开着。手机浏览器（可见区域变矮）
 * 和 App 里的网页（输入法把整个窗口顶小）都适用；横竖屏切换时重新记。
 * 输入框发送时用它决定发完以后输入法保持原样：开着的不关，关着的不弹出来（Composer.tsx）。
 */
const KEYBOARD_MIN = 120;

let width = 0;
let tallest = 0;

const visible = () => Math.min(window.innerHeight, window.visualViewport?.height ?? Infinity);

function measure(): void {
  if (window.innerWidth !== width) {
    width = window.innerWidth;
    tallest = 0;
  }
  tallest = Math.max(tallest, window.innerHeight, window.visualViewport?.height ?? 0);
}

if (typeof window !== "undefined") {
  measure();
  window.addEventListener("resize", measure);
  window.visualViewport?.addEventListener("resize", measure);
}

export function keyboardOpen(): boolean {
  measure();
  return tallest - visible() > KEYBOARD_MIN;
}
