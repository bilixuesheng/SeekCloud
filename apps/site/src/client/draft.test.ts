import { afterEach, describe, expect, it, vi } from "vitest";
import { readDraft, writeDraft } from "./draft";

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

describe("输入框的草稿", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("每个会话各记各的；清空时删掉，不留空记录", () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    writeDraft("abc12345", "改成蓝色");
    writeDraft("new", "写一份部署文档");
    expect(readDraft("abc12345")).toBe("改成蓝色");
    expect(readDraft("new")).toBe("写一份部署文档");
    expect(readDraft("other")).toBe("");
    writeDraft("abc12345", "");
    expect(readDraft("abc12345")).toBe("");
    expect([...storage.items.keys()]).toEqual(["seekcloud:draft:new"]);
  });

  it("浏览器不让存（无痕模式之类）时不报错，当作没有草稿", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => writeDraft("abc12345", "改成蓝色")).not.toThrow();
    expect(readDraft("abc12345")).toBe("");
  });
});
