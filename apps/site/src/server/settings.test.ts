import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const put = (browser: TestBrowser, body: unknown) =>
  browser.request("/api/settings/ai-labels", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("设置：AI 标识的两个开关", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  const start = async (text: string) => {
    const res = await browser.post("/api/sessions", { repo: "octo/app", baseBranch: "main", text });
    expect(res.status).toBe(201);
    await t.host.idle();
    return (await res.json()) as { shortId: string };
  };

  it("默认都开；没登录不能看也不能改", async () => {
    expect(await (await browser.get("/api/settings/ai-labels")).json()).toEqual({
      signature: true,
      commitTrailer: true,
    });
    expect((await t.browser().get("/api/settings/ai-labels")).status).toBe(401);
    expect((await put(t.browser(), { signature: false, commitTrailer: false })).status).toBe(401);
  });

  it("准备沙箱时把开关带给宿主机", async () => {
    await start("第一个会话");
    expect(t.host.last("prepare_sandbox").aiLabels).toEqual({
      signature: true,
      commitTrailer: true,
    });
  });

  it("两个开关各改各的，改完记得住；沙箱还开着的会话当场收到新的值", async () => {
    const before = t.host.commands.length;
    const res = await put(browser, { signature: false, commitTrailer: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: false, commitTrailer: true });
    expect(await (await browser.get("/api/settings/ai-labels")).json()).toEqual({
      signature: false,
      commitTrailer: true,
    });
    // 第一个会话的回合已经结束（等待回复），沙箱还开着
    const sent = t.host.commands.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "set_ai_labels",
      aiLabels: { signature: false, commitTrailer: true },
    });

    // 之后新开的会话，准备沙箱时带的是新的值
    await start("第二个会话");
    expect(t.host.last("prepare_sandbox").aiLabels).toEqual({
      signature: false,
      commitTrailer: true,
    });
  });

  it("格式不对：400，原来的值不变", async () => {
    for (const body of [{ signature: "no", commitTrailer: true }, { signature: true }, {}]) {
      expect((await put(browser, body)).status).toBe(400);
    }
    expect(await (await browser.get("/api/settings/ai-labels")).json()).toEqual({
      signature: false,
      commitTrailer: true,
    });
  });
});
