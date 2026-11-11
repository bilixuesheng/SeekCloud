import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Agent 输出的 Markdown 按白名单渲染", () => {
  it("常用格式照常渲染：标题、粗体、列表、代码块、表格", () => {
    const html = render(
      "## 改动\n\n**两处**：\n\n- `a.ts`\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    );
    expect(html).toContain("<h2>改动</h2>");
    expect(html).toContain("<strong>两处</strong>");
    expect(html).toContain("<code>a.ts</code>");
    expect(html).toContain('<code class="language-ts">const a = 1;\n</code>');
    expect(html).toContain("<td>1</td>");
  });

  it("代码块带复制按钮；任务列表的勾选框和文字在同一项里", () => {
    const html = render("```sh\npnpm test\n```\n\n- [x] 做完的\n- [ ] 没做的");
    expect(html).toMatch(/<div class="code-block"><pre>.*<\/pre><button[^>]*aria-label="复制"/s);
    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toMatch(
      /<li class="task-list-item"><input type="checkbox" disabled="" checked=""\/> 做完的<\/li>/,
    );
  });

  it("原始 HTML 不渲染，当成文字显示", () => {
    const html = render(
      '看这里 <img src=x onerror="alert(1)"> 和 <script>alert(2)</script>\n\n<div onclick="x">块</div>',
    );
    expect(html).not.toMatch(/<img|<script|<div onclick/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("正文里写的组件名不会被吞掉", () => {
    expect(render("用 <Button> 组件")).toContain("用 &lt;Button&gt; 组件");
  });

  it("javascript: 之类的链接不渲染成链接；正常链接在新标签页打开", () => {
    const html = render("[坏](javascript:alert(1)) [好](https://example.com)");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">好</a>',
    );
  });

  it("图片直接显示，不带 Referer；不是 http(s) 的地址不显示成图片", () => {
    const html = render("![截图](https://example.com/shot.png) ![坏](javascript:alert(1))");
    expect(html).toContain(
      '<img src="https://example.com/shot.png" alt="截图" referrerPolicy="no-referrer" loading="lazy"/>',
    );
    expect(html).not.toContain("javascript:");
  });
});
