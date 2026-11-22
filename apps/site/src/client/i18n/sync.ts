import { api } from "../api";
import { type LanguageSetting, reconcileLanguage } from "./index";

/**
 * 登录以后和主站对一下界面语言（#135）：以主站的为准；登录页上选过、主站还是"跟随浏览器"时，把选的存上去。
 * 读不到就算了，照这台浏览器上记的来。
 */
export async function syncLanguageWithSite(): Promise<void> {
  try {
    const { language } = await api<{ language: LanguageSetting }>("/api/settings/language");
    const upload = reconcileLanguage(language);
    if (upload) await api("/api/settings/language", { language: upload }, "PUT");
  } catch {}
}
