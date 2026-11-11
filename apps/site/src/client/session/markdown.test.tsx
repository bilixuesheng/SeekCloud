import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, trustedImageHost } from "./Markdown";

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

  it("GitHub 上的图片直接显示，不带 Referer；别的来源点了才加载；不是 http(s) 的地址不显示成图片", () => {
    const html = render(
      "![截图](https://user-images.githubusercontent.com/1/shot.png) ![外面的](https://example.com/shot.png?k=secret) ![坏](javascript:alert(1))",
    );
    expect(html).toContain(
      '<img src="https://user-images.githubusercontent.com/1/shot.png" alt="截图" referrerPolicy="no-referrer" loading="lazy"/>',
    );
    // 别的来源：页面上没有这个地址的 img，浏览器不会去请求它
    expect(html).not.toContain('src="https://example.com');
    expect(html).toMatch(
      /<button[^>]*class="image-blocked"[^>]*>.*外面的（来自 example\.com，点击加载）<\/button>/,
    );
    expect(html).not.toContain("javascript:");
  });

  it("哪些来源的图片直接显示：只认 GitHub 自己的域名，名字像的不算", () => {
    expect(trustedImageHost("https://raw.githubusercontent.com/o/r/main/a.png")).toBe(true);
    expect(trustedImageHost("https://github.com/o/r/assets/1/a.png")).toBe(true);
    expect(trustedImageHost("https://githubusercontent.com.evil.example/a.png")).toBe(false);
    expect(trustedImageHost("https://evilgithub.com/a.png")).toBe(false);
    expect(trustedImageHost("https://example.com/a.png")).toBe(false);
  });
});
