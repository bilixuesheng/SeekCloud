import { describe, expect, it } from "vitest";
import { decodeEntities, estimateDepth, htmlToMarkdown, htmlToText, MAX_HTML_DEPTH } from "./html";

describe("网页转成 Markdown", () => {
  it("标题、链接、列表、代码、表格都转过去；相对链接换成绝对地址", () => {
    const { markdown, converted } = htmlToMarkdown(
      `<html><head><title>页面</title></head><body>
        <h1>标题</h1>
        <p>正文 <a href="/docs?x=1">文档</a></p>
        <ul><li>一</li><li>二</li></ul>
        <pre><code class="language-js">let a = 1;</code></pre>
        <table><tr><th>名</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>
      </body></html>`,
      "https://example.com/page",
    );
    expect(converted).toBe(true);
    expect(markdown).toContain("# 标题");
    expect(markdown).toContain("[文档](https://example.com/docs?x=1)");
    expect(markdown).toMatch(/^- 一$/m);
    expect(markdown).toContain("```js\nlet a = 1;\n```");
    expect(markdown).toMatch(/\| 名 +\| 值 +\|/);
  });

  it("看不见的不要：脚本、样式、hidden、aria-hidden、display:none、隐藏的输入框、javascript: 和 data: 的地址", () => {
    const { markdown } = htmlToMarkdown(
      `<script>alert("秘密0")</script><style>.a{color:red}</style>
       <div hidden>秘密1</div><p style="display: none">秘密2</p><span aria-hidden="true">秘密3</span>
       <p style="visibility:hidden">秘密4</p><input type="hidden" value="秘密5">
       <p>看得见 <a href="javascript:alert(1)">点我</a> <img alt="图" src="data:image/png;base64,AAAA"></p>`,
      "https://example.com/",
    );
    expect(markdown).toContain("看得见");
    expect(markdown).not.toMatch(/秘密|alert|color:red|javascript:|data:image/);
  });

  it("嵌套太深的不解析，改用纯文本提取，而且很快", () => {
    const html = `${"<div>".repeat(20_000)}深处的字${"</div>".repeat(20_000)}`;
    const started = performance.now();
    const { markdown, converted } = htmlToMarkdown(html);
    expect(converted).toBe(false);
    expect(markdown).toContain("深处的字");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("大量没闭合、属性各不相同的格式标签（解析器会一次次重新打开它们）：也当作太深", () => {
    const html = Array.from({ length: 2000 }, (_, i) => `<p><b id="${i}">段落 ${i}</p>`).join("");
    expect(estimateDepth(html)).toBeGreaterThan(MAX_HTML_DEPTH);
    const started = performance.now();
    expect(htmlToMarkdown(html).converted).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("估深度：可以省结束标签的元素按同级算，文本里的小于号不算标签，属性里的尖括号不算标签", () => {
    expect(estimateDepth("<p>a<p>b<p>c")).toBe(1);
    expect(estimateDepth("<ul><li>a<li>b<li>c</ul>")).toBe(2);
    expect(estimateDepth("a < b and c > d")).toBe(0);
    // 格式标签在打开的元素里、没关掉的格式标签里各算一次（往多了估）
    expect(estimateDepth(`<a title="<div><div>">x</a>`)).toBe(3);
    // "< " 后面藏着的标签照样数到
    expect(estimateDepth("< <div>< <div>< <div>")).toBe(3);
    expect(estimateDepth("<script><div><div></script><div>")).toBe(1);
  });

  it("恶意的输入（没闭合的注释、一串小于号）不会让扫描变成平方级", () => {
    for (const html of ["<!--".repeat(200_000), "<".repeat(500_000), "<a".repeat(200_000)]) {
      const started = performance.now();
      estimateDepth(html);
      htmlToText(html);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });
});

describe("纯文本提取", () => {
  it("去掉标签、脚本、样式和头部，块级元素换行，列表项前面加横线，实体解码", () => {
    expect(
      htmlToText(
        `<head><title>不要</title></head><ul><li>一</li><li>二</li></ul><script>x()</script><style>p{}</style><p>段&amp;落</p><div>a<br>b</div>`,
      ),
    ).toBe("- 一\n- 二\n\n段&落\n\na\nb");
  });

  it("实体：数字的、常见有名字的；不认识的原样留着", () => {
    expect(decodeEntities("&lt;a&gt; &amp; &#20013;&#x6587; &hellip; &bogus; &#xd800;")).toBe(
      "<a> & 中文 … &bogus; &#xd800;",
    );
  });
});
