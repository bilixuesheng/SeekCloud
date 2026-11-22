import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // 跳到 /api/ 的页面（比如用 GitHub 登录）必须真的发到服务器，不能用缓存的首页代替。
      workbox: { navigateFallbackDenylist: [/^\/api\//] },
      // 清单中英各一份（public/manifest.zh-CN.webmanifest、manifest.en.webmanifest，#135），
      // index.html 里引用，public/locale-boot.js 按界面语言换；插件不再生成一份
      manifest: false,
    }),
  ],
  build: { outDir: "dist/client" },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
