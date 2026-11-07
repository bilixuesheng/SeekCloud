import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { clientConfig } from "./config";

/** Cloudflare Turnstile 在页面上挂的对象，这里只用到这几个方法。 */
interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

export type HumanCheckAction = "send_code" | "signup";

const siteKey = () => clientConfig().then((config) => config.turnstileSiteKey);

// Turnstile 的脚本整个页面只加载一次。
let scriptPromise: Promise<Turnstile> | undefined;
function loadTurnstile(): Promise<Turnstile> {
  scriptPromise ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("没有 turnstile"));
    script.onerror = () => {
      scriptPromise = undefined; // 下次再试
      reject(new Error("Turnstile 的脚本加载失败"));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

/** 等令牌最多等多久。等不到就不带令牌发请求，服务器那边按"没过人机验证"处理。 */
const WAIT_MS = 8000;

/**
 * 人机验证。大多数人看不到任何东西，Turnstile 在后台自动通过；
 * 需要人点一下时，小部件才出现在 widget 的位置。没配站点密钥时什么都不做。
 *
 * token()：取一个令牌用于这次请求。令牌只能用一次，取走后自动换一个新的，重试时不用刷新页面。
 */
export function useHumanCheck(
  action: HumanCheckAction,
  active: boolean,
): { widget: ReactNode; token: () => Promise<string | undefined> } {
  const container = useRef<HTMLDivElement>(null);
  const state = useRef<{
    token?: string;
    gaveUp: boolean;
    waiters: Array<(token: string | undefined) => void>;
    reset?: () => void;
  }>({ gaveUp: false, waiters: [] });

  useEffect(() => {
    if (!active) return;
    const s = state.current;
    s.token = undefined;
    s.gaveUp = false;
    const settle = (token: string | undefined) => {
      s.token = token;
      for (const resolve of s.waiters.splice(0)) resolve(token);
    };
    const giveUp = () => {
      s.gaveUp = true;
      settle(undefined);
    };
    let cancelled = false;
    let remove: (() => void) | undefined;
    (async () => {
      const key = await siteKey();
      if (cancelled) return;
      if (!key) return giveUp(); // 没配：服务器也不验证
      let turnstile: Turnstile;
      try {
        turnstile = await loadTurnstile();
      } catch {
        return giveUp(); // 连不上 Cloudflare：不带令牌，服务器按更紧的频率限制放行发验证码
      }
      if (cancelled || !container.current) return;
      const id = turnstile.render(container.current, {
        sitekey: key,
        action,
        theme: "auto",
        appearance: "interaction-only",
        size: "flexible",
        language: "zh-cn",
        callback: (token: string) => {
          s.gaveUp = false;
          settle(token);
        },
        "expired-callback": () => {
          s.token = undefined;
        },
        "error-callback": () => {
          giveUp();
        },
      });
      s.reset = () => turnstile.reset(id);
      // 看不见时容器高度是 0 但不是空的；有高度（需要人点一下）时才占位置，见 .human-check.visible
      const el = container.current;
      const resize = new ResizeObserver(() => {
        el.classList.toggle("visible", el.getBoundingClientRect().height > 0);
      });
      resize.observe(el);
      remove = () => {
        resize.disconnect();
        turnstile.remove(id);
      };
    })();
    return () => {
      cancelled = true;
      remove?.();
      s.reset = undefined;
    };
  }, [action, active]);

  const token = useCallback(async () => {
    const s = state.current;
    const take = (value: string | undefined) => {
      // 令牌只能用一次：取走以后让 Turnstile 再拿一个，留给下次请求。
      if (value) {
        s.token = undefined;
        s.reset?.();
      }
      return value;
    };
    if (s.token) return take(s.token);
    if (s.gaveUp) return undefined;
    const value = await new Promise<string | undefined>((resolve) => {
      s.waiters.push(resolve);
      setTimeout(() => resolve(undefined), WAIT_MS);
    });
    return take(value);
  }, []);

  return { widget: <div ref={container} className="human-check" />, token };
}
