import { cpSync } from "node:fs";
import { defineConfig } from "vite";

/**
 * 主站服务端的构建（#94）：把 src/server 打成普通的 JavaScript，放在 dist/server，生产环境（主站镜像）用 node 直接跑，
 * 不再用 tsx 跑源码。开发时照旧用 tsx（pnpm dev:server）。
 *
 * - 入口：主站（main.js）和镜像里要用的命令行工具（重置管理员密码、添加和吊销宿主机）。
 * - node_modules 里的依赖不打进来（运行时装生产依赖）；工作区里的 @seekcloud/protocol 是 TypeScript 源码，打进来。
 * - 入口和公共的块都放在 dist/server 这一层：迁移（db/migrate.ts）和目录快照（models/catalog.ts）按
 *   import.meta 的位置找文件，构建完把它们复制到同一层。
 */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node22",
    sourcemap: true,
    rolldownOptions: {
      input: {
        main: "src/server/main.ts",
        "reset-password": "src/server/cli/reset-password.ts",
        host: "src/server/cli/host.ts",
      },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
    },
  },
  plugins: [
    {
      name: "seekcloud-server-files",
      apply: "build",
      closeBundle() {
        cpSync("src/server/db/migrations", "dist/server/migrations", { recursive: true });
        cpSync("src/server/models/catalog.json", "dist/server/catalog.json");
      },
    },
  ],
});
