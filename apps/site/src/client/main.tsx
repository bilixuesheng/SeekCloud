import { preloadSerif } from "./fonts";
import { mountApp } from "./mount";
import { rememberedNickname } from "./nickname";
import { Registry } from "./registry";
import { prepareGreeting } from "./session/greetings";
import { localRegion } from "./session/region";
import { registerTrunk } from "./trunk";
import "@fontsource/noto-serif-sc/600.css";
import "./styles.css";

// 首页的问候语先挑好、先拉字体，不等登录状态回来
prepareGreeting(rememberedNickname(), preloadSerif, localRegion());

// 只做登记和挂载（ADR 0010）：页面、设置分类、插槽都在注册表里。
mountApp(document.getElementById("root") as HTMLElement, registerTrunk(new Registry()));
