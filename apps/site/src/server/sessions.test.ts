import type { SessionEvent } from "@seekcloud/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamedEvent } from "../testing/event-stream";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

const parse = (e: StreamedEvent) => JSON.parse(e.data) as SessionEvent;
const isWaiting = (e: StreamedEvent) => {
  const event = parse(e);
  return event.type === "status" && event.status === "waiting";
};

async function startSession(browser: TestBrowser, body: Record<string, unknown> = {}) {
  const res = await browser.post("/api/sessions", {
    repo: "octo/app",
    baseBranch: "main",
    text: "把首页的标题改成中文",
    ...body,
  });
  return { res, session: (await res.json()) as { shortId: string } & Record<string, unknown> };
}

/** 一个会话从头到现在的全部事件（读到等待回复为止）。 */
async function eventsUntilWaiting(browser: TestBrowser, id: string) {
  const stream = await browser.stream(`/api/sessions/${id}/events`);
  const events = (await stream.until(isWaiting)).map(parse);
  await stream.close();
  return events;
}

describe("发起会话，宿主机按脚本跑完一个回合", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(() => t.close());

  it("会话和第一个回合落库；状态按排队中 → 运行中 → 等待回复变化；事件带连续的序号", async () => {
    t.host.script(
      { type: "message", text: "我先看看代码。", thinking: "用户要改标题。" },
      { type: "tool.call", callId: "c1", name: "Read", input: { path: "index.html" } },
      { type: "tool.result", callId: "c1", output: "<h1>Home</h1>", isError: false },
      { type: "todo", items: [{ content: "改标题", status: "completed" }] },
      { type: "message", text: "改好了。" },
    );

    const { res, session } = await startSession(browser);
    expect(res.status).toBe(201);
    expect(session.shortId).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
    expect(session).toMatchObject({
      title: "把首页的标题改成中文",
      repos: [
        {
          fullName: "octo/app",
          baseBranch: "main",
          branch: `seekcloud/${session.shortId}`,
          access: "push",
        },
      ],
      model: "deepseek-flash",
      effort: "high",
    });

    const events = await eventsUntilWaiting(browser, session.shortId);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.map((e) => (e.type === "status" ? `status:${e.status}` : e.type))).toEqual([
      "user.message",
      "status:queued",
      "status:running",
      "status:running",
      "turn.started",
      "message",
      "tool.call",
      "tool.result",
      "todo",
      "message",
      "turn.ended",
      "status:waiting",
    ]);
    expect(events[2]).toMatchObject({ detail: "preparing_sandbox" });
    expect(events[3]).toMatchObject({ detail: null });
    expect(events.every((e) => e.turn === 1)).toBe(true);
    expect(events[5]).toMatchObject({ text: "我先看看代码。", thinking: "用户要改标题。" });

    const got = await (await browser.get(`/api/sessions/${session.shortId}`)).json();
    expect(got).toMatchObject({ shortId: session.shortId, status: "waiting", detail: null });
  });

  it("宿主机收到的命令：准备沙箱带上仓库、基础分支、会话分支和环境；然后开始回合", async () => {
    t.github.setBranches("octo/app", ["main", "dev"]);
    const { session } = await startSession(browser, { baseBranch: "dev", text: "修个 bug" });
    await t.host.idle();

    const environments = (await (await browser.get("/api/environments")).json()) as {
      environments: Array<{ id: string }>;
    };
    const prepare = t.host.last("prepare_sandbox");
    expect(prepare).toMatchObject({
      repos: [
        {
          fullName: "octo/app",
          baseBranch: "dev",
          branch: `seekcloud/${session.shortId}`,
          access: "push",
        },
      ],
      environmentId: environments.environments[0]?.id,
      model: "deepseek-flash",
      effort: "high",
    });
    expect(t.host.last("start_turn")).toMatchObject({
      sessionId: prepare.sessionId,
      text: "修个 bug",
    });
  });

  it("选模型和思考强度：宿主机按选的来；可选的模型列表从接口取", async () => {
    const models = (await (await browser.get("/api/models")).json()) as {
      models: Array<{ id: string; efforts: string[] }>;
      defaultModel: string;
      defaultEffort: string;
    };
    expect(models.defaultModel).toBe("deepseek-flash");
    expect(models.defaultEffort).toBe("high");
    expect(models.models.map((m) => m.id)).toContain("deepseek-v4-pro");
    expect(models.models[0]?.efforts).toEqual(["off", "low", "high", "max"]);

    const { session } = await startSession(browser, { model: "deepseek-v4-pro", effort: "max" });
    await t.host.idle();

    expect(session).toMatchObject({ model: "deepseek-v4-pro", effort: "max" });
    expect(t.host.last("prepare_sandbox")).toMatchObject({
      model: "deepseek-v4-pro",
      effort: "max",
    });
  });

  it("公开仓库没装 App：只读挂载", async () => {
    t.github.addPublicRepo("someone/lib");
    const { res, session } = await startSession(browser, { repo: "someone/lib" });

    expect(res.status).toBe(201);
    expect(session.repos).toEqual([expect.objectContaining({ access: "read" })]);
  });

  it("断线后带 Last-Event-ID 重连：只补发之后的事件", async () => {
    const { session } = await startSession(browser);
    await t.host.idle();

    const stream = await browser.stream(`/api/sessions/${session.shortId}/events`, {
      "last-event-id": "5",
    });
    const rest = (await stream.until(isWaiting)).map(parse);
    await stream.close();

    expect(rest[0]?.seq).toBe(6);
    expect(rest.at(-1)?.type).toBe("status");
  });

  it("等待回复时再发消息，开始第 2 个回合，跑完又回到等待回复", async () => {
    const { session } = await startSession(browser);
    await t.host.idle();
    t.host.script({ type: "message", text: "第二个回合。" });

    const reply = await browser.post(`/api/sessions/${session.shortId}/messages`, {
      text: "再改一下",
    });
    expect(reply.status).toBe(201);
    await t.host.idle();

    const stream = await browser.stream(`/api/sessions/${session.shortId}/events`);
    const all: SessionEvent[] = [];
    while (all.filter((e) => e.type === "status" && e.status === "waiting").length < 2) {
      all.push(parse(await stream.next()));
    }
    await stream.close();
    const second = all.filter((e) => e.turn === 2);
    expect(second.map((e) => (e.type === "status" ? `status:${e.status}` : e.type))).toEqual([
      "user.message",
      "status:running",
      "turn.started",
      "message",
      "turn.ended",
      "status:waiting",
    ]);
    expect(t.host.last("start_turn").text).toBe("再改一下");
  });

  it("发消息时换模型和思考强度：从这个回合起生效，事件里记一笔", async () => {
    const { session } = await startSession(browser);
    await t.host.idle();
    expect(t.host.last("start_turn")).toMatchObject({ model: "deepseek-flash", effort: "high" });

    const reply = await browser.post(`/api/sessions/${session.shortId}/messages`, {
      text: "换个强点的模型再看看",
      model: "deepseek-v4-pro",
      effort: "max",
    });
    expect(reply.status).toBe(201);
    expect(await reply.json()).toMatchObject({ model: "deepseek-v4-pro", effort: "max" });
    await t.host.idle();
    expect(t.host.last("start_turn")).toMatchObject({
      text: "换个强点的模型再看看",
      model: "deepseek-v4-pro",
      effort: "max",
    });

    const stream = await browser.stream(`/api/sessions/${session.shortId}/events`);
    const events = (await stream.until((e) => parse(e).type === "model.changed")).map(parse);
    await stream.close();
    expect(events.at(-1)).toMatchObject({ turn: 2, model: "deepseek-v4-pro", effort: "max" });

    // 不换就不记。
    await browser.post(`/api/sessions/${session.shortId}/messages`, { text: "继续" });
    await t.host.idle();
    expect(t.host.last("start_turn")).toMatchObject({ model: "deepseek-v4-pro", effort: "max" });
    const bad = await browser.post(`/api/sessions/${session.shortId}/messages`, {
      text: "换个不存在的",
      model: "gpt-9",
    });
    expect(bad.status).toBe(400);
  });

  it("Agent 还在工作时发消息：先排队（202），不打断当前回合", async () => {
    t.host.manual = true;
    try {
      const { session } = await startSession(browser);
      const busy = await browser.post(`/api/sessions/${session.shortId}/messages`, {
        text: "快点",
      });
      expect(busy.status).toBe(202);
      expect(await busy.json()).toMatchObject({ queued: { text: "快点" } });
    } finally {
      t.host.manual = false;
    }
  });

  it("沙箱建不起来：会话失败，事件里写明错误类别和参考号", async () => {
    t.host.failNextSandbox({ code: "sandbox_unavailable", ref: "d1sk" });
    const { session } = await startSession(browser);
    await t.host.idle();

    const stream = await browser.stream(`/api/sessions/${session.shortId}/events`);
    const events = (
      await stream.until((e) => {
        const event = parse(e);
        return event.type === "status" && event.status === "failed";
      })
    ).map(parse);
    await stream.close();

    expect(events.at(-1)).toMatchObject({
      status: "failed",
      error: { code: "sandbox_unavailable", ref: "d1sk" },
    });
    expect(await (await browser.get(`/api/sessions/${session.shortId}`)).json()).toMatchObject({
      status: "failed",
    });
  });
});

describe("实时同步", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("sync", "sync/app"));
    t.host.manual = true;
  });
  afterAll(() => t.close());

  it("两个浏览器同时打开同一个会话：宿主机上报的事件，两边都实时收到", async () => {
    const { session } = await startSession(browser, { repo: "sync/app" });
    const phone = await browser.stream(`/api/sessions/${session.shortId}/events`);
    const laptop = await browser.stream(`/api/sessions/${session.shortId}/events`);
    for (const stream of [phone, laptop]) {
      await stream.until((e) => parse(e).type === "status" && parse(e).seq === 3);
    }

    const sessionId = t.host.last("prepare_sandbox").sessionId;
    await t.host.emit({ type: "sandbox.ready", sessionId });
    const turnId = t.host.last("start_turn").turnId;
    await t.host.emit({
      type: "agent",
      sessionId,
      turnId,
      event: { type: "message", text: "两边都能看到我" },
    });

    for (const stream of [phone, laptop]) {
      const seen = (await stream.until((e) => parse(e).type === "message")).map(parse);
      expect(seen.at(-1)).toMatchObject({ seq: 5, text: "两边都能看到我" });
      await stream.close();
    }
  });

  it("宿主机补发的迟到、重复事件被忽略：回合结束了不会再改状态", async () => {
    const { session } = await startSession(browser, { repo: "sync/app" });
    const sessionId = t.host.last("prepare_sandbox").sessionId;
    await t.host.emit({ type: "sandbox.ready", sessionId });
    const first = t.host.last("start_turn").turnId;
    const ended = { type: "turn.ended", reason: "completed" } as const;
    await t.host.emit({ type: "agent", sessionId, turnId: first, event: ended });
    await browser.post(`/api/sessions/${session.shortId}/messages`, { text: "第二个回合" });
    const second = t.host.last("start_turn").turnId;
    expect(second).not.toBe(first);

    // 第 1 个回合的"回合结束"又来了一次，还夹着一条迟到的消息：第 2 个回合照常运行。
    await t.host.emit({ type: "agent", sessionId, turnId: first, event: ended });
    await t.host.emit({
      type: "agent",
      sessionId,
      turnId: first,
      event: { type: "message", text: "迟到的" },
    });
    // 沙箱失败以后，宿主机补发的事件也不再记录。
    await t.host.emit({ type: "sandbox.failed", sessionId, error: { code: "internal" } });
    await t.host.emit({ type: "agent", sessionId, turnId: second, event: ended });
    await t.host.emit({ type: "sandbox.failed", sessionId, error: { code: "internal" } });

    const stream = await browser.stream(`/api/sessions/${session.shortId}/events`);
    const events = (
      await stream.until((e) => {
        const event = parse(e);
        return event.type === "status" && event.status === "failed";
      })
    ).map(parse);
    await stream.close();
    expect(events.filter((e) => e.type === "turn.ended")).toHaveLength(1);
    expect(events.some((e) => e.type === "message")).toBe(false);
    expect(await (await browser.get(`/api/sessions/${session.shortId}`)).json()).toMatchObject({
      status: "failed",
    });
    // 失败之后没有别的事件了（第二次"沙箱失败"也被忽略）。
    const rest = await browser.stream(
      `/api/sessions/${session.shortId}/events?after=${events.at(-1)?.seq}`,
    );
    await expect(rest.next(200)).rejects.toThrow("等事件超时");
    await rest.close();
  });

  it("宿主机报上来的错误只留下类别、状态码和参考号：上游地址、原始报错一律到不了浏览器", async () => {
    const leaked = "https://line-2.internal.example.com/anthropic/v1/messages";
    const { session } = await startSession(browser, { repo: "sync/app" });
    const sessionId = t.host.last("prepare_sandbox").sessionId;
    await t.host.emit({ type: "sandbox.ready", sessionId });
    const turnId = t.host.last("start_turn").turnId;
    // 模拟宿主机的代码出了错：错误里多带了原始报错，状态码和参考号也不像样。
    const dirty = {
      code: "model_unavailable",
      status: 502,
      ref: "a1b2",
      message: `upstream ${leaked} returned 502`,
    };
    await t.host.emit({
      type: "agent",
      sessionId,
      turnId,
      event: { type: "turn.ended", reason: "failed", error: dirty as never },
    });
    await browser.post(`/api/sessions/${session.shortId}/messages`, { text: "再试一次" });
    await t.host.emit({
      type: "sandbox.failed",
      sessionId,
      error: { code: `connect ${leaked}`, status: 99_999, ref: leaked } as never,
    });

    const stream = await browser.stream(`/api/sessions/${session.shortId}/events`);
    const events = (
      await stream.until((e) => {
        const event = parse(e);
        return event.type === "status" && event.status === "failed";
      })
    ).map(parse);
    await stream.close();

    // objectContaining 里的 error 要完全相等：多带的 message 字段会让断言失败。
    expect(events.find((e) => e.type === "turn.ended")).toEqual(
      expect.objectContaining({ error: { code: "model_unavailable", status: 502, ref: "a1b2" } }),
    );
    // 不认识的类别算内部错误；不像样的状态码和参考号直接丢掉。
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ status: "failed", error: { code: "internal" } }),
    );
    expect(JSON.stringify(events)).not.toContain("internal.example.com");
  });

  it("会话列表流：先发全部会话，之后哪个会话有变化就推哪个", async () => {
    const existing = (await (await browser.get("/api/sessions")).json()) as { sessions: unknown[] };
    const list = await browser.stream("/api/sessions/stream");
    const snapshot = JSON.parse((await list.next()).data) as { sessions: unknown[] };
    expect(snapshot.sessions).toEqual(existing.sessions);

    const { session } = await startSession(browser, { repo: "sync/app", text: "第二个会话" });
    const pushed = await list.until((e) => {
      const data = JSON.parse(e.data) as { shortId?: string; status?: string };
      return e.event === "session" && data.shortId === session.shortId && data.status === "running";
    });
    await list.close();

    expect(pushed.at(-1)?.event).toBe("session");
    expect(JSON.parse(pushed.at(-1)?.data ?? "{}")).toMatchObject({
      title: "第二个会话",
      detail: "preparing_sandbox",
    });
  });

  it("不存在的会话：404，事件流也打不开，发不了消息；没登录：401", async () => {
    expect((await browser.get("/api/sessions/nope0000")).status).toBe(404);
    expect((await browser.get("/api/sessions/nope0000/events")).status).toBe(404);
    expect((await browser.post("/api/sessions/nope0000/messages", { text: "嗨" })).status).toBe(
      404,
    );
    const { session } = await startSession(browser, { repo: "sync/app" });
    expect((await t.browser().get(`/api/sessions/${session.shortId}`)).status).toBe(401);
  });
});

describe("没有宿主机", () => {
  it("新会话留在排队中", async () => {
    const t = await createTestApp({ host: false });
    try {
      const { browser } = await t.adminWithGitHub("lonely", "lonely/app");
      const { session } = await startSession(browser, { repo: "lonely/app" });

      expect(session.status).toBe("queued");
      const list = (await (await browser.get("/api/sessions")).json()) as {
        sessions: Array<{ status: string }>;
      };
      expect(list.sessions.map((s) => s.status)).toEqual(["queued"]);
    } finally {
      await t.close();
    }
  });
});

describe("发起会话时的检查", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("check", "check/app"));
  });
  afterAll(() => t.close());

  const errorCode = (body: Record<string, unknown>) => (body.error as { code: string }).code;

  it("没登录：401", async () => {
    const body = { repo: "check/app", baseBranch: "main", text: "嗨" };
    expect((await t.browser().post("/api/sessions", body)).status).toBe(401);
    expect((await t.request("/api/sessions/stream")).status).toBe(401);
  });

  it("没写内容：400", async () => {
    const { res } = await startSession(browser, { repo: "check/app", text: "   " });
    expect(res.status).toBe(400);
  });

  it("没有这个模型：400；思考强度不在可选范围：400", async () => {
    const unknown = await startSession(browser, { repo: "check/app", model: "gpt-9" });
    expect(unknown.res.status).toBe(400);
    expect(errorCode(unknown.session)).toBe("model_not_found");
    const badEffort = await startSession(browser, { repo: "check/app", effort: "ultra" });
    expect(badEffort.res.status).toBe(400);
  });

  it("仓库没装 App、也不是公开仓库：404", async () => {
    const { res, session } = await startSession(browser, { repo: "secret/repo" });
    expect(res.status).toBe(404);
    expect(errorCode(session)).toBe("repo_not_found");
  });

  it("基础分支不存在：400", async () => {
    const { res, session } = await startSession(browser, { repo: "check/app", baseBranch: "nope" });
    expect(res.status).toBe(400);
    expect(errorCode(session)).toBe("branch_not_found");
  });

  it("环境不存在：404", async () => {
    const { res, session } = await startSession(browser, {
      repo: "check/app",
      environmentId: "00000000-0000-4000-8000-000000000000",
    });
    expect(res.status).toBe(404);
    expect(errorCode(session)).toBe("environment_not_found");
  });

  it("还没关联 GitHub：409，引导去关联", async () => {
    expect((await browser.post("/api/github/unlink", {})).status).toBe(204);

    const { res, session } = await startSession(browser, { repo: "check/app" });
    expect(res.status).toBe(409);
    expect(errorCode(session)).toBe("github_not_connected");
  });

  it("用户在 GitHub 上撤销了授权：409，并算作没关联", async () => {
    const { browser: revoked, user } = await t.adminWithGitHub("revoked", "revoked/app");
    t.github.revoke(user);

    const { res, session } = await startSession(revoked, { repo: "revoked/app" });
    expect(res.status).toBe(409);
    expect(errorCode(session)).toBe("github_not_connected");
    expect(await (await revoked.get("/api/github/status")).json()).toMatchObject({
      connected: false,
    });
  });
});
