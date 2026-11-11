// 设置里选的外观（跟随系统 / 浅色 / 深色）。在页面画出来之前设好，免得先闪一下另一种颜色。
// 单独一个文件、在 <head> 里同步加载：内容安全策略不允许内联脚本。
try {
  const theme = localStorage.getItem("seekcloud:theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
    // 地址栏、状态栏的颜色也跟着选的外观，不跟系统（颜色和 theme.ts 的 PAGE_COLOR 一致）
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.content = theme === "dark" ? "#15171c" : "#fbfcff";
    }
  }
} catch {}
