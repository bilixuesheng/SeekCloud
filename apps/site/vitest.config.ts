import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    globalSetup: ["src/testing/global-setup.ts"],
    // 界面的文案固定用中文（src/testing/locale-setup.ts）
    setupFiles: ["src/testing/locale-setup.ts"],
  },
});
