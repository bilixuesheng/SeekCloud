import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANDROID_ERRORS_FILE,
  ANDROID_GREETINGS,
  ANDROID_LOCALES,
  androidErrorMessages,
  androidGreetings,
  androidStrings,
  androidText,
} from "./android";

/**
 * 安卓 App 的 strings.xml 从文案目录生成（#204）。改了 app-zh.ts、app-en.ts 而没重新生成时失败。
 * 重新生成：在仓库根目录运行 pnpm --filter @seekcloud/site android:strings
 */
const APP = new URL("../../../../android/", import.meta.url);
const RES = new URL("app/src/main/res/", APP);
const COMMAND = "pnpm --filter @seekcloud/site android:strings";

describe("安卓 App 的文案", () => {
  for (const { locale, dir } of ANDROID_LOCALES) {
    it(`${dir}/strings.xml 是最新的`, () => {
      const file = new URL(`${dir}/strings.xml`, RES);
      const text = androidStrings(locale);
      if (process.env.UPDATE_ANDROID_STRINGS) writeFileSync(file, text);
      expect(
        readFileSync(file, "utf8") === text,
        `App 的文案改了而 strings.xml 没有重新生成：在仓库根目录运行 ${COMMAND}`,
      ).toBe(true);
    });
  }

  for (const { dir, set } of ANDROID_GREETINGS) {
    it(`${dir}/greetings.json 是最新的`, () => {
      const file = new URL(`${dir}/greetings.json`, RES);
      const text = androidGreetings(set);
      if (process.env.UPDATE_ANDROID_STRINGS) {
        mkdirSync(new URL(".", file), { recursive: true });
        writeFileSync(file, text);
      }
      expect(
        readFileSync(file, "utf8") === text,
        `问候语改了而 App 的没有重新生成：在仓库根目录运行 ${COMMAND}`,
      ).toBe(true);
    });
  }

  it("报错码对应文案的表是最新的", () => {
    const file = new URL(ANDROID_ERRORS_FILE, APP);
    const text = androidErrorMessages();
    if (process.env.UPDATE_ANDROID_STRINGS) writeFileSync(file, text);
    expect(
      readFileSync(file, "utf8") === text,
      `网页目录里的报错改了而 App 的没有重新生成：在仓库根目录运行 ${COMMAND}`,
    ).toBe(true);
  });

  it("App 用网页目录里的报错、状态和会话列表的文案，键换成安卓的写法", () => {
    expect(androidStrings("zh-CN")).toContain(
      '<string name="status_awaiting_input" tools:ignore="UnusedResources">等你输入</string>',
    );
    expect(androidStrings("zh-CN")).toContain('<string name="session_list_empty"');
    expect(androidStrings("en")).toContain('<string name="sidebar_pinned"');
    expect(androidStrings("zh-CN")).toContain(
      '<string name="error_unauthorized" tools:ignore="UnusedResources">请先登录。</string>',
    );
    expect(androidStrings("en")).toContain('<plurals name="error_rate_limited"');
    expect(androidErrorMessages()).toContain(
      '"session_not_found" to R.string.error_session_not_found,',
    );
    expect(androidErrorMessages()).toContain('"rate_limited" to R.plurals.error_rate_limited,');
  });

  it("插值按中文里第一次出现的顺序编号，两种语言一样", () => {
    expect(androidText("{a} 和 {b}", "X", ["a", "b"])).toBe("%1$s 和 %2$s");
    expect(androidText("{b} then {a}", "X", ["a", "b"])).toBe("%2$s then %1$s");
    expect(androidText("{count} items", "X", ["count"])).toBe("%1$d items");
    expect(() => androidText("{c}", "X", ["a"])).toThrow();
  });

  it("品牌名直接写进去", () => {
    expect(androidText("Welcome to {brand}", "SeekCloud", [])).toBe("Welcome to SeekCloud");
  });

  it("照安卓资源的规矩转义", () => {
    expect(androidText(`It's "ok" \\ <b> & more`, "X", [])).toBe(
      `It\\'s \\"ok\\" \\\\ &lt;b&gt; &amp; more`,
    );
    expect(androidText("@home", "X", [])).toBe("\\@home");
    expect(androidText("?why", "X", [])).toBe("\\?why");
    expect(androidText("100% of {a}", "X", ["a"])).toBe("100%% of %1$s");
    expect(androidText("100%", "X", [])).toBe("100%");
    expect(() => androidText(" padded", "X", [])).toThrow();
    expect(() => androidText("two  spaces", "X", [])).toThrow();
  });
});
