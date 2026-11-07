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
      manifest: {
        name: "SeekCloud",
        short_name: "SeekCloud",
        description: "云端编程智能体。代码无界，智能随行。",
        lang: "zh-CN",
        start_url: "/",
        display: "standalone",
        background_color: "#fbfcff",
        theme_color: "#fbfcff",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  build: { outDir: "dist/client" },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
