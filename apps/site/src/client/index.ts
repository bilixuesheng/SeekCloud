// 浏览器端的公开出口（ADR 0010）：下游版本只从这里拿东西。包名下的路径是 @seekcloud/site/client。
//
//   const registry = registerTrunk(new Registry());
//   registry.settings({ id: "billing", name: "账单", icon: <CardIcon />, component: Billing, order: 35 });
//   mountApp(document.getElementById("root"), registry);

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
  useRegistry,
} from "./registry";
export { navigate, pathOf, type Route, useRoute } from "./router";
export { type Me, type ShellValue, useShell } from "./shell";
export { registerTrunk } from "./trunk";
