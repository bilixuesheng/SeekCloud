import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KeyField } from "./KeyField";
import { type KeyDraft, keyPatch } from "./types";

/** API 密钥输入框的提示（照 dsh 的模型页）和保存时发给接口的值。 */

const render = (props: {
  masked?: string | null;
  env?: string[];
  envDetected?: string | null;
  draft?: KeyDraft;
}) =>
  renderToStaticMarkup(
    <KeyField
      masked={props.masked ?? null}
      env={props.env ?? []}
      envDetected={props.envDetected ?? null}
      draft={props.draft ?? { kind: "keep" }}
      onDraft={() => undefined}
    />,
  );

describe("API 密钥输入框", () => {
  it("已保存：输入框里是脱敏预览，绿色的“使用已保存的密钥”，没有眼睛按钮", () => {
    const html = render({ masked: "sk-01234••••••••wxyz" });
    expect(html).toContain('value="sk-01234••••••••wxyz"');
    expect(html).toContain('class="key-field-hint ok">使用已保存的密钥');
    expect(html).not.toContain("显示密钥");
  });

  it("没保存：检测到环境变量是绿色，没检测到是黄色并列出变量名；自定义接口没有变量名时请输入", () => {
    expect(render({ env: ["OPENAI_API_KEY"], envDetected: "OPENAI_API_KEY" })).toContain(
      'class="key-field-hint ok">检测到环境变量 OPENAI_API_KEY',
    );
    expect(render({ env: ["OPENAI_API_KEY"] })).toContain(
      'class="key-field-hint warn">未检测到 OPENAI_API_KEY，请输入 API 密钥或配置该环境变量',
    );
    expect(render({})).toContain('class="key-field-hint warn">请输入 API 密钥');
    expect(render({ env: ["X_KEY"] })).toContain('placeholder="留空使用环境认证"');
  });

  it("换成新的：提示保存以替换，有眼睛按钮；暂存删除：提示保存后改用环境变量", () => {
    const replacing = render({
      masked: "sk-01234••••••••wxyz",
      draft: { kind: "replace", value: "sk-new" },
    });
    expect(replacing).toContain("保存以替换已保存的密钥");
    expect(replacing).toContain('aria-label="显示密钥"');
    expect(
      render({
        masked: "sk-01234••••••••wxyz",
        env: ["DEEPSEEK_API_KEY"],
        draft: { kind: "delete" },
      }),
    ).toContain("保存后删除已保存的密钥，改用环境变量 DEEPSEEK_API_KEY");
  });

  it("保存时：不动不发，删掉发 null，新的去掉首尾空白", () => {
    expect(keyPatch({ kind: "keep" })).toBeUndefined();
    expect(keyPatch({ kind: "delete" })).toBeNull();
    expect(keyPatch({ kind: "replace", value: "  sk-abc  " })).toBe("sk-abc");
  });
});
