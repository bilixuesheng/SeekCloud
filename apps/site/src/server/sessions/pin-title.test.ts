import { describe, expect, it } from "vitest";
import { pinTitle } from "./pin-title";

describe("置顶消息的短标题", () => {
  it("有小标题就用第一个小标题", () => {
    expect(pinTitle(["先看代码。", "## 改了什么\n- 首页标题"])).toBe("改了什么");
  });

  it("没有小标题就用最后一段回复里第一句够长的话，去掉 Markdown 标记", () => {
    expect(pinTitle(["收到。", "收到。**测试都过了**，一共 42 个。"])).toBe(
      "测试都过了，一共 42 个",
    );
    expect(pinTitle(["改好了 `src/app.ts`。"])).toBe("改好了 src/app.ts");
  });

  it("太长的截到 20 个字；前半句够长就只用前半句", () => {
    expect(pinTitle(["这是一句非常非常长的回复长到放不进左上角那一列置顶的列表里面去。"])).toBe(
      "这是一句非常非常长的回复长到放不进左上角…",
    );
    expect(pinTitle(["这是一句非常非常长的回复，长到放不进左上角那一列置顶的列表里面去。"])).toBe(
      "这是一句非常非常长的回复",
    );
  });

  it("什么都取不出来时给一个默认的", () => {
    expect(pinTitle(["  "])).toBe("置顶的消息");
  });

  it("不把路径截在中间：句子先取逗号前的半句，单词不长就整个留下", () => {
    expect(pinTitle(["我看了 `src/pages/index.tsx`，标题写死在组件里。"])).toBe(
      "我看了 src/pages/index.tsx",
    );
    expect(
      pinTitle([
        "这次一共改动了很多个文件，其中最关键的是 apps/site/src/client/session/SessionPage.tsx 那个",
      ]),
    ).toBe("这次一共改动了很多个文件");
    expect(
      pinTitle(["修好了会话页底部那一行的显示 apps/site/src/client/session/SessionPage.tsx"]),
    ).toBe("修好了会话页底部那一行的显示…");
  });
});
