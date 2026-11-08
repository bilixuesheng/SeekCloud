import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Licenses } from "./LegalPage";

const html = renderToStaticMarkup(<Licenses />);
const text = html.replace(/<[^>]+>/g, "");

describe("开源声明页上 SeekCloud 自己的声明", () => {
  it("保留 NOTICE 附加条款要求的署名，仓库地址是可以点开的链接", () => {
    expect(text).toContain("基于 SeekCloud（https://github.com/bilixuesheng/SeekCloud）");
    expect(html).toContain('<a href="https://github.com/bilixuesheng/SeekCloud"');
  });

  it("写明版权、AGPL-3.0 和不提供担保", () => {
    expect(text).toContain("Copyright (C) 2026 XUESHENG");
    expect(text).toContain("GNU Affero 通用公共许可证第 3 版（AGPL-3.0）");
    expect(text).toContain("不提供任何担保");
  });

  it("放在第三方软件的列表之前", () => {
    expect(text.indexOf("基于 SeekCloud")).toBeLessThan(text.indexOf("使用了以下开源软件"));
  });
});
