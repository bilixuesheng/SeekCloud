/**
 * 浏览器登录时记下是什么浏览器、什么系统（"Chrome · macOS"），设置里的登录设备列表上显示，
 * 好分得清是哪一台（以前每一行都叫"浏览器"）。只为了给人看：认不出来的为空，不做别的判断。
 * 存的是浏览器、系统的英文正式名称（WeChat、QQ Browser）：服务端不存现成的中文，两种界面语言下都这么显示（#136）。
 */

/** 浏览器：先认套壳的（它们的 UA 里也带 Chrome、Safari），再认本体。 */
const BROWSERS: Array<[RegExp, string]> = [
  [/MicroMessenger\//, "WeChat"],
  [/\bQQ\//, "QQ"],
  [/QQBrowser\//, "QQ Browser"],
  [/UCBrowser\//, "UC Browser"],
  [/HuaweiBrowser\//, "Huawei Browser"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(Chrome|CriOS|HeadlessChrome)\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
];

/** 系统：手机、平板在前（iPhone 的 UA 里也有"like Mac OS X"）。 */
const SYSTEMS: Array<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\b(HarmonyOS|OpenHarmony)\b/, "HarmonyOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\b(Macintosh|Mac OS X)\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

export function describeUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
  if (browser && system) return `${browser} · ${system}`;
  return browser ?? system ?? null;
}
