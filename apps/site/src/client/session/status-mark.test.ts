import type { SessionState } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";
import { resetForTests } from "../i18n";
import { statusMark, statusText, statusWithDetail } from "./types";

describe("侧栏的状态标记和状态文字（#139）", () => {
  const s = (
    status: SessionState["status"],
    detail: SessionState["detail"] = null,
  ): SessionState => ({
    status,
    detail,
  });

  it.each([
    [s("failed"), true, "failed"],
    [s("running"), true, "running"],
    [s("queued"), false, "running"],
    [s("running", "preparing_sandbox"), false, "running"],
    [s("waiting", "awaiting_input"), true, "awaiting"],
    [s("waiting", "awaiting_input"), false, "awaiting"],
    [s("dormant", "awaiting_input"), false, "awaiting"],
    [s("archived", "awaiting_input"), false, null],
    [s("waiting", "done"), true, "unread"],
    [s("waiting", "done"), false, null],
    [s("waiting"), true, "unread"],
    [s("dormant"), false, null],
  ])("%j，有新内容 %s → %s", (state, unread, mark) => {
    expect(statusMark(state, unread)).toBe(mark);
  });

  it("状态文字带上附加说明", () => {
    expect(statusText(s("waiting", "awaiting_input"))).toBe("等你输入");
    expect(statusText(s("waiting", "done"))).toBe("已完成");
    expect(statusText(s("dormant", "done"))).toBe("休眠");
    expect(statusText(s("running", "preparing_sandbox"))).toBe("正在准备沙箱");
    expect(statusWithDetail(s("dormant", "awaiting_input"))).toBe("休眠 · 等你输入");
    expect(statusWithDetail(s("waiting"))).toBe("等待回复");
  });

  it("英文", () => {
    resetForTests("en");
    try {
      expect(statusText(s("waiting", "awaiting_input"))).toBe("Awaiting input");
      expect(statusText(s("queued"))).toBe("Queued");
      expect(statusWithDetail(s("dormant", "awaiting_input"))).toBe("Dormant · Awaiting input");
      expect(statusWithDetail(s("running", "preparing_sandbox"))).toBe(
        "Running · Preparing sandbox",
      );
    } finally {
      resetForTests("zh-CN");
    }
  });
});
