import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

/**
 * 界面文案只写在文案目录里（#135，规格 #134）：扫描 src/client 下的组件和代码，字符串、模板字符串、JSX 里的文字
 * 出现汉字就失败。注释不算；正则不算（比如匹配汉字的正则）；文案目录（zh.ts）和测试不算；
 * 给开发者看的话在那一行或上一行注明"不是界面文案"。
 *
 * 还没迁的文件先列在豁免清单里，#136 一页一页迁完，清单为空。清单里的文件已经没有汉字了，也会失败：提醒把它从清单里删掉。
 */
const PENDING = new Set([
  "legal/LegalPage.tsx",
  "legal/licenses.ts",
  "session/ChangesCard.tsx",
  "session/ChangesPanel.tsx",
  "session/Markdown.tsx",
  "session/SessionPage.tsx",
  "session/errors.ts",
  "session/timeline.ts",
  "settings/DataSettings.tsx",
  "settings/ModelSettings.tsx",
  "settings/PasskeySettings.tsx",
  "settings/SessionSettings.tsx",
  "settings/SettingsDialog.tsx",
  "settings/TwoFactorSettings.tsx",
  "settings/models/AddProvider.tsx",
  "settings/models/KeyField.tsx",
  "settings/models/ModelEditor.tsx",
  "settings/models/ModelFields.tsx",
  "settings/models/ProviderCard.tsx",
  "settings/models/tokens.ts",
  "settings/models/url-check.ts",
]);

/** 本身就是文案的文件（目录、中文的问候语，和各种语言用自己的文字写的名字）。 */
const CATALOGS = new Set(["i18n/zh.ts", "i18n/catalog.ts", "i18n/greetings-zh.ts"]);

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

describe("组件里没有写死的中文（#135）", () => {
  const files = sources(ROOT).filter((f) => !CATALOGS.has(f));

  it("不在豁免清单里的文件：字符串、JSX 文字里没有汉字（要加文案就写进 i18n/zh.ts 和 en.ts）", () => {
    const offenders = files.filter((f) => !PENDING.has(f)).flatMap(hardcoded);
    expect(offenders).toEqual([]);
  });

  it("豁免清单里的文件都还在、都还有汉字（迁完了就从清单里删掉）", () => {
    const stale = [...PENDING].filter((f) => !files.includes(f) || hardcoded(f).length === 0);
    expect(stale).toEqual([]);
  });
});
