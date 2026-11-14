import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { preloadSerif } from "./fonts";
import { rememberedNickname } from "./nickname";
import { prepareGreeting } from "./session/greetings";
import "@fontsource/noto-serif-sc/600.css";
import "./styles.css";

// 首页的问候语先挑好、先拉字体，不等登录状态回来
prepareGreeting(rememberedNickname(), preloadSerif);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
