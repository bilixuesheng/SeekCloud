import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

export const SETTINGS_SECTIONS = ["general", "github", "account"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** 不用登录也能看的页面：开源声明。 */
export const LEGAL_DOCS = ["licenses"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

export type Route =
  | { page: "home" }
  | { page: "legal"; doc: LegalDoc }
  | { page: "settings"; section: SettingsSection }
  | { page: "session"; id: string };

/** 一个页面的地址。 */
export function pathOf(route: Route): string {
  if (route.page === "session") return `/s/${route.id}`;
  if (route.page === "settings") return `/settings/${route.section}`;
  if (route.page === "legal") return `/${route.doc}`;
  return "/";
}

function parse(path: string): Route {
  const legal = LEGAL_DOCS.find((doc) => path.replace(/\/$/, "") === `/${doc}`);
  if (legal) return { page: "legal", doc: legal };
  const settings = path.match(/^\/settings(?:\/([a-z]+))?\/?$/);
  if (settings) {
    const section = SETTINGS_SECTIONS.find((s) => s === settings[1]) ?? "account";
    return { page: "settings", section };
  }
  const match = path.match(/^\/s\/([0-9a-z]+)\/?$/);
  return match ? { page: "session", id: match[1] as string } : { page: "home" };
}

// 应用里点链接换页时淡入淡出；浏览器的前进后退不加，手机上的返回手势本身就有动画，叠在一起反而乱。
let animateNext = false;

// 手机上铺满整屏的侧栏开着时，换页不做过渡：过渡时主区域单独画在最上面，会透过侧栏露出来。
let overlayOpen = false;

/** 侧栏开着还是关着，App 里跟着侧栏的状态设；只在侧栏盖在页面上（手机）时管用。 */
export function setOverlayOpen(open: boolean): void {
  overlayOpen = open;
}

/**
 * 换页面，不刷新。transition 为 false 时直接换，不做淡入上浮：
 * 手机上从铺满整屏的侧栏里点进去时，侧栏自己滑走就是过渡，主区域再动一下反而像抖了一下。
 */
export function navigate(path: string, { transition = true }: { transition?: boolean } = {}): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  animateNext = transition;
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** 侧栏是不是盖在页面上的那种（手机上铺满整屏）。和 styles.css 里侧栏的断点一致。 */
export const sidebarOverlays = () => window.matchMedia("(max-width: 899px)").matches;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 当前页面只有这一份，用到它的组件都订阅这里。
// 不能每个组件各听各的 popstate：先听到的那个把"要过渡"拿走、在过渡里换页，
// 后听到的就直接换了页，浏览器拍"换页前"那张画面时新页面已经画出来，过渡等于没做。
// （测试在 Node 里跑，没有 window。）
const browser = typeof window !== "undefined";
let current: Route = browser ? parse(window.location.pathname) : { page: "home" };
const subscribers = new Set<() => void>();

function onPopState(): void {
  const next = parse(window.location.pathname);
  // 设置是盖在页面上的弹窗，开、关、切换分类都由弹窗自己的动画管。
  // 这时要是做换页的过渡，主区域会单独画在最上面，底下的页面就透过弹窗露出来。
  const animate =
    animateNext &&
    !(overlayOpen && sidebarOverlays()) &&
    next.page !== "settings" &&
    current.page !== "settings";
  animateNext = false;
  const show = () => {
    current = next;
    for (const notify of subscribers) notify();
  };
  if (!animate || !document.startViewTransition || reducedMotion()) {
    show();
    return;
  }
  // 新页面要在回调里同步渲染出来，浏览器才能拿新旧两张画面做过渡。
  document.startViewTransition(() => flushSync(show));
}

if (browser) window.addEventListener("popstate", onPopState);

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current);
}
