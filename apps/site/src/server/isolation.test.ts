import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeIdentity } from "../testing/fake-identity";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

/**
 * 属于一个人的数据都按身份来源给的 ID 过滤（ADR 0010）。主干只有一个管理员，这里用测试替身放进第二个人，
 * 拿甲的 ID 以乙的身份调每个接口：一律按"不存在"返回，甲的数据不变。
 */
describe("两个人互相看不到对方的数据", () => {
  const identity = new FakeIdentity();
  let t: TestApp;
  let alice: TestBrowser;
  let bob: TestBrowser;
  let session: { shortId: string; sessionId: string; queueId: string; envId: string };
  let exportId: string;
  let errorRef: string;
  let groupId: string;

  beforeAll(async () => {
    t = await createTestApp({ identity: identity.attach });
    alice = await identity.signIn(t.browser(), await identity.addUser("甲"));
    bob = await identity.signIn(t.browser(), await identity.addUser("乙"));
    await t.linkGitHub(alice, "alice", "alice/app");
    await t.linkGitHub(bob, "bob", "bob/app");

    // 甲有一个正在跑的会话，里面有一条排队的消息。
    t.host.manual = true;
    const envs = (await (await alice.get("/api/environments")).json()).environments;
    const created = await alice.post("/api/sessions", {
      repo: "alice/app",
      baseBranch: "main",
      text: "第一件事",
    });
    expect(created.status).toBe(201);
    const { shortId } = (await created.json()) as { shortId: string };
    const sessionId = t.host.last("prepare_sandbox").sessionId;
    await t.host.emit({ type: "sandbox.ready", sessionId });
    const queued = await alice.post(`/api/sessions/${shortId}/messages`, { text: "顺便改按钮" });
    expect(queued.status).toBe(202);
    const queueId = ((await queued.json()) as { queued: { id: string } }).queued.id;
    session = { shortId, sessionId, queueId, envId: envs[0].id };

    // 甲在侧栏里建了一个分组。
    const group = await alice.post("/api/session-groups", { name: "甲的分组" });
    expect(group.status).toBe(201);
    groupId = ((await group.json()) as { id: string }).id;

    // 甲有一份打包好的数据导出。
    expect((await alice.post("/api/account/export")).status).toBe(202);
    await t.runMaintenance();
    exportId = (await (await alice.get("/api/account/export")).json()).latest.id;

    // 甲的会话调模型时上游出过一次错，原始报错按参考号存着。
    t.model.reply({ status: 500, body: "甲的上游报错" });
    const failed = await t.request("/api/gateway/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${t.host.credential}`,
        "x-seekcloud-session": sessionId,
      },
      body: JSON.stringify({ model: "deepseek-flash", max_tokens: 10, messages: [] }),
    });
    errorRef = /参考号 (\w+)/.exec((await failed.json()).error.message)?.[1] as string;
    expect((await alice.get(`/api/model-errors/${errorRef}`)).status).toBe(200);
  });
  afterAll(() => t.close());

  /** 每个带着某个人的数据 ID 的接口，以乙的身份用甲的 ID 去调。新加这类接口时要在这里加一行。 */
  const foreignCalls = (): Record<string, () => Promise<Response>> => {
    const s = `/api/sessions/${session.shortId}`;
    return {
      "GET /api/sessions/{shortId}": () => bob.get(s),
      "GET /api/sessions/{shortId}/events": () => bob.get(`${s}/events`),
      "POST /api/sessions/{shortId}/messages": () => bob.post(`${s}/messages`, { text: "乙的话" }),
      "POST /api/sessions/{shortId}/stop": () => bob.post(`${s}/stop`),
      "POST /api/sessions/{shortId}/queue/{queueId}/withdraw": () =>
        bob.post(`${s}/queue/${session.queueId}/withdraw`),
      "POST /api/sessions/{shortId}/queue/{queueId}/send-now": () =>
        bob.post(`${s}/queue/${session.queueId}/send-now`),
      "POST /api/sessions/{shortId}/rename": () => bob.post(`${s}/rename`, { title: "乙改的" }),
      "GET /api/sessions/{shortId}/pins": () => bob.get(`${s}/pins`),
      "GET /api/sessions/{shortId}/diff": () => bob.get(`${s}/diff`),
      "POST /api/sessions/{shortId}/pins": () => bob.post(`${s}/pins`, { seq: 1, pinned: true }),
      "POST /api/sessions/{shortId}/read": () => bob.post(`${s}/read`, { unread: true }),
      "POST /api/sessions/{shortId}/pin": () => bob.post(`${s}/pin`, { pinned: true }),
      "POST /api/sessions/{shortId}/archive": () => bob.post(`${s}/archive`),
      "POST /api/sessions/{shortId}/unarchive": () => bob.post(`${s}/unarchive`),
      "POST /api/sessions/{shortId}/delete": () => bob.post(`${s}/delete`),
      "GET /api/account/export/{id}/download": () =>
        bob.get(`/api/account/export/${exportId}/download`),
      "GET /api/model-errors/{ref}": () => bob.get(`/api/model-errors/${errorRef}`),
      "POST /api/sessions/{shortId}/place": () =>
        bob.post(`${s}/place`, { section: "pinned", after: null }),
      "PATCH /api/session-groups/{id}": () =>
        bob.request(`/api/session-groups/${groupId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "乙改的分组" }),
        }),
      "DELETE /api/session-groups/{id}": () =>
        bob.request(`/api/session-groups/${groupId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
    };
  };

  it("接口文档里每个带 ID 的接口都在上面的清单里", async () => {
    const doc = (await (await t.request("/api/openapi.json")).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const withIds = Object.entries(doc.paths)
      .filter(([path]) => path.includes("{"))
      .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`))
      // 仓库的分支：按乙自己关联的 GitHub 账号去查，不是谁的数据 ID
      .filter((route) => route !== "GET /api/github/repos/{owner}/{repo}/branches");
    expect(withIds.sort()).toEqual(Object.keys(foreignCalls()).sort());
  });

  it("用甲的 ID 调每个接口，一律按不存在返回", async () => {
    for (const [route, call] of Object.entries(foreignCalls())) {
      const res = await call();
      expect(res.status, route).toBe(404);
    }
  });

  it("乙的调用没有动到甲的会话：没改名、没归档、没删、没停、排队的消息还在", async () => {
    const res = await alice.get(`/api/sessions/${session.shortId}`);
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.title).not.toBe("乙改的");
    expect(view.status).toBe("running");
    expect(view.pinnedAt).toBeNull();
    expect(view.unread).toBe(false);
    expect((await (await alice.get(`/api/sessions/${session.shortId}/pins`)).json()).pins).toEqual(
      [],
    );
    const mine = t.host.commands.filter(
      (c) => "sessionId" in c && c.sessionId === session.sessionId,
    );
    expect(mine.map((c) => c.type)).not.toContain("stop_turn");
    expect(mine.map((c) => c.type)).not.toContain("inject_message");
    const withdraw = await alice.post(
      `/api/sessions/${session.shortId}/queue/${session.queueId}/withdraw`,
    );
    expect(withdraw.status).toBe(200);
  });

  it("侧栏的分组：乙看不到甲的分组，也不能把自己的会话放进甲的分组；甲的分组没被改名、没被删", async () => {
    const bobGroups = (await (await bob.get("/api/session-groups")).json()).groups as {
      id: string;
    }[];
    expect(bobGroups.map((g) => g.id)).not.toContain(groupId);
    const own = await bob.post("/api/sessions", {
      repo: "bob/app",
      baseBranch: "main",
      text: "乙自己的",
    });
    const { shortId } = (await own.json()) as { shortId: string };
    const placed = await bob.post(`/api/sessions/${shortId}/place`, {
      section: "group",
      groupId,
      after: null,
    });
    expect(placed.status).toBe(404);
    expect((await placed.json()).error.code).toBe("group_not_found");
    const aliceGroups = (await (await alice.get("/api/session-groups")).json()).groups;
    expect(aliceGroups).toEqual([expect.objectContaining({ id: groupId, name: "甲的分组" })]);
  });

  it("会话列表和列表的事件流里只有自己的会话", async () => {
    const list = (await (await bob.get("/api/sessions")).json()).sessions as { shortId: string }[];
    expect(list.map((s) => s.shortId)).not.toContain(session.shortId);

    const stream = await bob.stream("/api/sessions/stream");
    try {
      const snapshot = JSON.parse((await stream.next()).data) as {
        sessions: { shortId: string }[];
      };
      expect(snapshot.sessions.map((s) => s.shortId)).not.toContain(session.shortId);
      // 甲的会话有了动静，乙收不到
      await alice.post(`/api/sessions/${session.shortId}/rename`, { title: "甲改的" });
      await expect(stream.next(200)).rejects.toThrow();
    } finally {
      await stream.close();
    }
  });

  it("环境：列表里只有自己的；拿甲的环境发起会话按不存在返回", async () => {
    const envs = (await (await bob.get("/api/environments")).json()).environments as {
      id: string;
    }[];
    expect(envs.map((e) => e.id)).not.toContain(session.envId);

    const res = await bob.post("/api/sessions", {
      repo: "bob/app",
      baseBranch: "main",
      text: "用甲的环境",
      environmentId: session.envId,
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("environment_not_found");
  });

  it("数据导出：看不到甲的导出", async () => {
    const overview = await (await bob.get("/api/account/export")).json();
    expect(overview.latest).toBeNull();
  });

  it("乙看到的是自己的资料，不是甲的", async () => {
    const me = await (await bob.get("/api/me")).json();
    expect(me.nickname).toBe("乙");
    expect(me.githubLogin).toBe("bob");
  });
});
