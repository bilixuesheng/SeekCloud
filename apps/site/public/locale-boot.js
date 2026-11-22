// 界面语言（#135）：在页面画出来之前设好 <html lang>、标题和 PWA 清单，免得先闪一下另一种语言。
// 单独一个文件、在 <head> 里同步加载：内容安全策略不允许内联脚本。
// 选法和 src/client/i18n/index.ts 的 resolveLocale 一样（i18n/locale-boot.test.ts 核对两边一致）：
// 设置里选的（登录页上选的优先，再是上次从主站读到的）→ 浏览器语言列表里第一个支持的（zh 开头的都算中文）→ 英文。
(() => {
  const valid = (v) => v === "auto" || v === "zh-CN" || v === "en";
  let setting = "auto";
  try {
    const picked = localStorage.getItem("seekcloud:language-picked");
    const stored = localStorage.getItem("seekcloud:language");
    setting = valid(picked) ? picked : valid(stored) ? stored : "auto";
  } catch {}
  let locale = setting === "auto" ? null : setting;
  if (!locale) {
    const list = navigator.languages?.length ? navigator.languages : [navigator.language || ""];
    for (const tag of list) {
      const lang = String(tag).toLowerCase();
      if (lang === "zh" || lang.startsWith("zh-")) {
        locale = "zh-CN";
        break;
      }
      if (lang === "en" || lang.startsWith("en-")) {
        locale = "en";
        break;
      }
    }
  }
  locale = locale || "en";
  document.documentElement.lang = locale;
  // 中文界面用中文名"云上求索"（2026-11-18 定的），英文界面用 SeekCloud
  document.title = locale === "zh-CN" ? "云上求索" : "SeekCloud";
  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest) manifest.href = `/manifest.${locale}.webmanifest`;
})();
