import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

export const SETTINGS_SECTIONS = ["general", "account", "privacy"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** 不用登录也能看的三份文件：用户协议、隐私政策、开源声明。 */
export const LEGAL_DOCS = ["terms", "privacy", "licenses"] as const;
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

/** 换页面，不刷新。 */
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  animateNext = true;
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.pathname));
  useEffect(() => {
    const update = () => {
      const next = parse(window.location.pathname);
      const animate = animateNext;
      animateNext = false;
      if (!animate || !document.startViewTransition || reducedMotion()) {
        setRoute(next);
        return;
      }
      // 新页面要在回调里同步渲染出来，浏览器才能拿新旧两张画面做过渡。
      document.startViewTransition(() => flushSync(() => setRoute(next)));
    };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return route;
}
