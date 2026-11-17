import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { type Registry, RegistryProvider } from "./registry";
import { setPages } from "./router";

/** 挂载应用：注册表里的页面交给路由，再把整个应用画进 root。注册表在这之后不要再改。 */
export function mountApp(root: HTMLElement, registry: Registry): void {
  setPages(registry.pages);
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider registry={registry}>
        <App />
      </RegistryProvider>
    </StrictMode>,
  );
}
