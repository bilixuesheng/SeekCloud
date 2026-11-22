import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { addMessages } from "./i18n";
import { type Registry, RegistryProvider } from "./registry";
import { setPages } from "./router";
import { ConfirmHost } from "./ui/confirm";
import { ToastHost } from "./ui/toast";

/**
 * 挂载应用：注册表里的页面交给路由，再把整个应用画进 root。注册表在这之后不要再改。
 * messages 是再叠一层的文案目录（ADR 0010、#135）：盖掉同名的键。
 */
export function mountApp(
  root: HTMLElement,
  registry: Registry,
  options: { messages?: Parameters<typeof addMessages>[0] } = {},
): void {
  if (options.messages) addMessages(options.messages);
  setPages(registry.pages);
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider registry={registry}>
        <App />
        {/* 右下角的通知、确认弹窗：哪一页都能用（ui/toast.tsx、ui/confirm.tsx） */}
        <ToastHost />
        <ConfirmHost />
      </RegistryProvider>
    </StrictMode>,
  );
}
