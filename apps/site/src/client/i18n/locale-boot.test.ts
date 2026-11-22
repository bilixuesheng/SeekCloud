import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { resolveLocale } from "./index";

/**
 * public/locale-boot.js 在页面画出来之前按同样的规矩选语言，设好 <html lang>、标题和 PWA 清单。
 * 两边各写了一份（启动脚本不能 import），这里核对它们选出来的一样。
 */
const script = readFileSync(join(import.meta.dirname, "../../../public/locale-boot.js"), "utf8");

function boot(stored: Record<string, string>, languages: string[]) {
  const html = { lang: "" };
  const link = { href: "/manifest.zh-CN.webmanifest" };
  const doc = { documentElement: html, title: "", querySelector: () => link };
  runInNewContext(script, {
    document: doc,
    navigator: { languages, language: languages[0] ?? "" },
    localStorage: { getItem: (k: string) => stored[k] ?? null },
  });
  return { lang: html.lang, title: doc.title, manifest: link.href };
}

describe("页面画出来之前的语言（public/locale-boot.js）", () => {
  it.each([
    [{}, ["zh-CN", "en"]],
    [{}, ["ja", "zh-TW"]],
    [{}, ["en-GB", "zh-CN"]],
    [{}, ["ja"]],
    [{}, []],
    [{ "seekcloud:language": "en" }, ["zh-CN"]],
    [{ "seekcloud:language": "zh-CN" }, ["en-US"]],
    [{ "seekcloud:language": "auto" }, ["zh-HK"]],
    [{ "seekcloud:language": "zh-CN", "seekcloud:language-picked": "en" }, ["zh-CN"]],
    [{ "seekcloud:language": "garbage" }, ["zh-CN"]],
  ])("记的 %j，浏览器 %j：和 resolveLocale 一样", (stored, languages) => {
    const picked = stored["seekcloud:language-picked" as keyof typeof stored];
    const saved = stored["seekcloud:language" as keyof typeof stored];
    const valid = (v?: string) => (v === "auto" || v === "zh-CN" || v === "en" ? v : undefined);
    const expected = resolveLocale(valid(picked) ?? valid(saved) ?? "auto", languages);
    const result = boot(stored, languages);
    expect(result.lang).toBe(expected);
    expect(result.manifest).toBe(`/manifest.${expected}.webmanifest`);
    expect(result.title).toBe(expected === "zh-CN" ? "云上求索" : "SeekCloud");
  });

  it("两份 PWA 清单：中文的叫云上求索，英文的叫 SeekCloud，图标一样", () => {
    const read = (name: string) =>
      JSON.parse(readFileSync(join(import.meta.dirname, `../../../public/${name}`), "utf8"));
    const zh = read("manifest.zh-CN.webmanifest");
    const en = read("manifest.en.webmanifest");
    expect([zh.name, zh.lang, en.name, en.lang]).toEqual(["云上求索", "zh-CN", "SeekCloud", "en"]);
    expect(zh.icons).toEqual(en.icons);
  });
});
