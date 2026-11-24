import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

/**
 * 界面文案只写在文案目录里（#135、#136，规格 #134）：扫描 src/client 下的组件和代码，字符串、模板字符串、
 * JSX 里的文字出现汉字就失败。注释不算；正则不算（比如匹配汉字的正则）；文案目录（zh.ts）和测试不算；
 * 给开发者看的话、规定照原文显示的话（开源声明页的署名），在那一行或上一行注明"不是界面文案"。
 * #136 迁完了全部页面，不再有豁免的文件。
 */

/** 本身就是文案的文件（目录、中文的问候语，和各种语言用自己的文字写的名字）。 */
const CATALOGS = new Set([
  "i18n/zh.ts",
  "i18n/app-zh.ts",
  "i18n/catalog.ts",
  "i18n/greetings-zh.ts",
]);

/** 给开发者看的话（控制台提示、程序用错时抛的错）不是界面文案：那一行或上一行写上这个注释就不算。 */
const NOT_UI = "不是界面文案";

const ROOT = join(import.meta.dirname, "..");
const HAN = /\p{Script=Han}/u;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [relative(ROOT, path)];
  });
}

/** 一个文件里带汉字的字符串：第几行、什么字。 */
function hardcoded(file: string): string[] {
  const code = readFileSync(join(ROOT, file), "utf8");
  const { program } = parseSync(file, code, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  const found: string[] = [];
  const lines = code.split("\n");
  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length;
  const exempt = (line: number) =>
    lines[line - 1]?.includes(NOT_UI) || lines[line - 2]?.includes(NOT_UI);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown> & { type?: string; start?: number };
    const text =
      n.type === "Literal" && typeof n.value === "string" && !n.regex
        ? n.value
        : n.type === "TemplateElement"
          ? (n.value as { raw: string }).raw
          : n.type === "JSXText"
            ? (n.value as string)
            : undefined;
    const line = lineOf(n.start ?? 0);
    if (text && HAN.test(text) && !exempt(line)) {
      found.push(`${file}:${line} ${text.trim().slice(0, 40)}`);
    }
    for (const [key, value] of Object.entries(n)) {
      if (key !== "type" && key !== "start" && key !== "end") visit(value);
    }
  };
  visit(program);
  return found;
}

describe("组件里没有写死的中文（#135、#136）", () => {
  it("字符串、JSX 文字里没有汉字（要加文案就写进 i18n/zh.ts 和 en.ts）", () => {
    const offenders = sources(ROOT)
      .filter((f) => !CATALOGS.has(f))
      .flatMap(hardcoded);
    expect(offenders).toEqual([]);
  });
});
