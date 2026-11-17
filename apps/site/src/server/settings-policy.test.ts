import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";
import type { SettingsActor, SettingsPolicy } from "./ports";
import { adminSettings, type SettingKey } from "./settings";

/** 换掉设置的读写规则（扩展点，ADR 0010）：默认值和能不能改都听规则的。主干的规则见 settings.test.ts。 */
describe("设置的读写规则", () => {
  const asked: { key: SettingKey; actor: SettingsActor; kind: "default" | "write" }[] = [];
  const policy: SettingsPolicy = {
    defaultValue: (key, actor) => {
      asked.push({ key, actor, kind: "default" });
      return key === "default_effort" ? ("low" as never) : adminSettings.defaultValue(key, actor);
    },
    canWrite: (key, actor) => {
      asked.push({ key, actor, kind: "write" });
      return key !== "ai_labels";
    },
  };
  let t: TestApp;
  let browser: TestBrowser;
  let me: string;

  beforeAll(async () => {
    t = await createTestApp({ settingsPolicy: policy });
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
    me = (await (await browser.get("/api/me")).json()).id;
  });
  afterAll(() => t.close());

  it("没改过的设置用规则给的默认值：设置接口、模型列表、新会话都一样", async () => {
    expect(await (await browser.get("/api/settings/default-effort")).json()).toEqual({
      effort: "low",
    });
    expect((await (await browser.get("/api/models")).json()).defaultEffort).toBe("low");
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "看看",
    });
    expect((await res.json()).effort).toBe("low");
    expect(asked.filter((a) => a.kind === "default").every((a) => a.actor.userId === me)).toBe(
      true,
    );
  });

  it("规则不让改的设置，修改回 403 setting_locked，值不变", async () => {
    const res = await browser.request("/api/settings/ai-labels", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature: false, commitTrailer: false }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("setting_locked");
    expect(await (await browser.get("/api/settings/ai-labels")).json()).toEqual({
      signature: true,
      commitTrailer: true,
    });
    expect(t.host.commands.some((c) => c.type === "set_ai_labels")).toBe(false);
    expect(asked).toContainEqual({ key: "ai_labels", actor: { userId: me }, kind: "write" });
  });

  it("规则让改的设置照常改，改过以后读到的是存下的值，不再问默认值", async () => {
    const res = await browser.request("/api/settings/default-effort", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "max" }),
    });
    expect(res.status).toBe(200);
    asked.length = 0;
    expect(await (await browser.get("/api/settings/default-effort")).json()).toEqual({
      effort: "max",
    });
    expect(asked.filter((a) => a.key === "default_effort")).toEqual([]);
  });
});
