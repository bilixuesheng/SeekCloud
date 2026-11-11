export type Theme = "system" | "light" | "dark";

const KEY = "seekcloud:theme";

let switching = 0;

/** 页面底色，和 styles.css 的 --page、index.html 里的 theme-color 一致。 */
const PAGE_COLOR = { light: "#fbfcff", dark: "#15171c" } as const;

/**
 * 浏览器地址栏、手机状态栏的颜色（theme-color）跟着选的外观走。
 * index.html 里的两个 meta 是按系统的深浅色写的；手动选了浅色或深色时，两个都改成选的那种。
 */
function syncThemeColor(theme: Theme): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const system = meta.media.includes("dark") ? "dark" : "light";
    meta.content = PAGE_COLOR[theme === "system" ? system : theme];
  }
}

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * 换外观：写在 html 的 data-theme 上（index.html 里启动时读回来），记在浏览器里。
 * 浏览器支持 View Transitions 时整页淡入淡出过去；`update` 在同一帧里把界面上的选中状态也换掉，
 * 不然新画面里还是旧的选项。
 */
export function setTheme(theme: Theme, update?: () => void): void {
  const apply = () => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    syncThemeColor(theme);
    update?.();
  };
  const root = document.documentElement;
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply();
  } else {
    // 连点时上一次过渡会被跳过、先结束，不能让它把这一次的标记摘掉。
    const id = ++switching;
    root.classList.add("theme-switch");
    document.startViewTransition(apply).finished.finally(() => {
      if (id === switching) root.classList.remove("theme-switch");
    });
  }
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {}
}
