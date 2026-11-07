import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { charDelay, type LiveChunk } from "./live-text";
import { githubRef, Markdown, SessionLinks } from "./Markdown";

const chunk = (from: number, to: number): LiveChunk => ({ id: from, from, to, born: 0 });
const render = (text: string, chunks: LiveChunk[] = []) =>
  renderToStaticMarkup(<Markdown text={text} chunks={chunks} />);

describe("Agent 回复的文字浮现", () => {
  it("没有正在浮现的段落时（历史消息）照常渲染，不多一个 span", () => {
    expect(render("你好 **世界**")).toBe(
      '<div class="markdown"><p>你好 <strong>世界</strong></p></div>',
    );
  });

  it("新来的一段包成片段，一个字一个 span，从左往右错开；之前的字不动", () => {
    const text = "第一句。第二句";
    const html = render(text, [chunk(4, text.length)]);
    expect(html).toBe(
      '<div class="markdown"><p>第一句。<span class="chunk">' +
        '<span style="animation-delay:0ms">第</span>' +
        '<span style="animation-delay:14ms">二</span>' +
        '<span style="animation-delay:28ms">句</span></span></p></div>',
    );
  });

  it("加粗、链接里的字也照原文的位置算", () => {
    const html = render("看 **这里**", [chunk(4, 6)]);
    expect(html).toContain(
      '<strong><span class="chunk"><span style="animation-delay:0ms">这</span>',
    );
    expect(html).toMatch(/^<div class="markdown"><p>看 <strong>/);
  });

  it("代码块和表格里的字只淡入、不上浮", () => {
    const text = "```ts\nconst a = 1;\n```\n\n| a |\n|---|\n| 1 |";
    const html = render(text, [chunk(0, text.length)]);
    expect(html).toContain('<code class="language-ts"><span class="chunk chunk-fade">');
    expect(html).toContain('<td><span class="chunk chunk-fade">');
    expect(html).not.toContain('<span class="chunk">');
  });

  it("长的一段整体在 0.24 秒里扫过去，短的一段每个字错开 14 毫秒", () => {
    expect(charDelay(2, 5)).toBe(28);
    expect(charDelay(999, 1000)).toBeLessThanOrEqual(240);
  });
});

describe("回复里的链接", () => {
  const withSession = (text: string) =>
    renderToStaticMarkup(
      <SessionLinks.Provider
        value={{ repo: "octo/app", pullRequest: { number: 42, state: "merged" } }}
      >
        <Markdown text={text} />
      </SessionLinks.Provider>,
    );

  it("认出 GitHub 上 PR 和 issue 的地址", () => {
    expect(githubRef("https://github.com/octo/app/pull/42")).toEqual({
      repo: "octo/app",
      kind: "pull",
      number: 42,
    });
    expect(githubRef("https://github.com/octo/app/issues/7#issuecomment-1")).toMatchObject({
      kind: "issue",
      number: 7,
    });
    expect(githubRef("https://github.com/octo/app/blob/main/a.ts")).toBeUndefined();
    expect(githubRef("https://evil.example/octo/app/pull/1")).toBeUndefined();
  });

  it("会话自己的 PR：胶囊上是真实状态和编号，不显示网址", () => {
    const html = withSession("开好了：https://github.com/octo/app/pull/42");
    expect(html).toContain('class="link-chip"');
    expect(html).toContain('<span class="pr-badge merged"');
    expect(html).toContain("</span>#42</a>");
    expect(html).not.toContain(">https://github.com");
  });

  it("别的仓库、别的 PR 和 issue：带仓库名，图标不带状态颜色", () => {
    const html = withSession("[#3](https://github.com/other/lib/issues/3)");
    expect(html).toContain('<span class="pr-badge"><svg');
    expect(html).toContain("other/lib#3</a>");
  });

  it("写了说明文字的链接照常显示文字，不变成胶囊", () => {
    const html = withSession("[修复登录的 PR](https://github.com/octo/app/pull/42)");
    expect(html).not.toContain("link-chip");
    expect(html).toContain(">修复登录的 PR</a>");
  });
});
