import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

import type { PageEntry, RouteParams } from "./registry";

/** 当前的页面：注册表里一个页面的标识，加上地址里的参数。 */
export interface Route {
  page: string;
  params: RouteParams;
}

interface CompiledPage {
  entry: PageEntry;
  pattern: RegExp;
  names: string[];
}

/** 把 "/s/:id"、"/settings/:section?" 这样的样式换成正则；参数是一段不带斜杠的文字。 */
function compile(entry: PageEntry): CompiledPage {
  const names: string[] = [];
  const source = entry.path
    .split("/")
    .filter(Boolean)
    .map((part) => {
      const param = part.match(/^:([A-Za-z]\w*)(\?)?$/);
      if (!param) return `/${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
      names.push(param[1] as string);
      return param[2] ? "(?:/([^/]+))?" : "/([^/]+)";
    })
    .join("");
  return { entry, pattern: new RegExp(`^${source}/?$`), names };
}

let table: CompiledPage[] = [];

/** 找不到的地址回首页：主干登记的首页标识是 home。 */
const HOME: Route = { page: "home", params: {} };

/** 地址里写坏了的 % 转义原样保留，不让整页报错。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 在页面表里找这个地址对应的页面；找不到时回首页。 */
export function matchPath(pages: readonly PageEntry[], path: string): Route {
  for (const page of pages.map(compile)) {
    const match = path.match(page.pattern);
    if (!match) continue;
    const params: RouteParams = {};
    page.names.forEach((name, i) => {
      const value = match[i + 1];
      if (value !== undefined) params[name] = safeDecode(value);
    });
    return { page: page.entry.id, params };
  }
  return HOME;
}

/** 一个页面的地址。可以没有的参数没给时，那一段不写。 */
export function pathOf(route: Route): string {
  const page = table.find((p) => p.entry.id === route.page);
  if (!page) return "/";
  const path = page.entry.path
    .split("/")
    .filter(Boolean)
    .flatMap((part) => {
      const param = part.match(/^:([A-Za-z]\w*)(\?)?$/);
      if (!param) return [part];
      const value = route.params[param[1] as string];
      return value === undefined ? [] : [encodeURIComponent(value)];
    })
    .join("/");
  return `/${path}`;
}

/** 这个页面是不是盖在原来页面上的弹窗（设置）。 */
export const isOverlay = (route: Route): boolean =>
  table.find((p) => p.entry.id === route.page)?.entry.overlay === true;

/** 挂载应用时把注册表里的页面交给路由，按当前地址算出现在在哪一页。 */
export function setPages(pages: readonly PageEntry[]): void {
  table = pages.map(compile);
  if (browser) current = matchPath(pages, window.location.pathname);
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
let current: Route = HOME;
const subscribers = new Set<() => void>();

function onPopState(): void {
  const next = matchPath(
    table.map((p) => p.entry),
    window.location.pathname,
  );
  // 设置是盖在页面上的弹窗，开、关、切换分类都由弹窗自己的动画管。
  // 这时要是做换页的过渡，主区域会单独画在最上面，底下的页面就透过弹窗露出来。
  const animate =
    animateNext && !(overlayOpen && sidebarOverlays()) && !isOverlay(next) && !isOverlay(current);
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
