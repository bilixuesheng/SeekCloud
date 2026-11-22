// 浏览器端的公开出口（ADR 0010）：下游版本只从这里拿东西。包名下的路径是 @seekcloud/site/client。
//
//   const registry = registerTrunk(new Registry());
//   registry.settings({ id: "billing", name: () => tAny("billing.title"), icon: <CardIcon />, component: Billing, order: 35 });
//   mountApp(document.getElementById("root"), registry, {
//     // 再叠一层文案目录：盖掉主干的几条（比如品牌名），也可以放自己的键，用 tAny 取
//     messages: { "zh-CN": { "billing.title": "账单" }, en: { "billing.title": "Billing" } },
//   });

export {
  addMessages,
  currentLocale,
  type Locale,
  type Message,
  pageTitle,
  t,
  tAny,
  useLocale,
  useT,
} from "./i18n";
export { mountApp } from "./mount";
export {
  type OverlayProps,
  type PageEntry,
  type PageProps,
  Registry,
  type RouteParams,
  type SettingsSectionEntry,
  type SettingsSectionProps,
  SLOTS,
  Slot,
  type SlotEntry,
  type SlotName,
  sectionName,
  useRegistry,
} from "./registry";
export { navigate, pathOf, type Route, useRoute } from "./router";
export { type Me, type ShellValue, useShell } from "./shell";
export { registerTrunk } from "./trunk";
