import { LINK_CLOSE, type SessionEvent } from "@seekcloud/protocol";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../testing/database";
import { TestHostClient } from "../../testing/host-client";
import { createTestApp, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";
import { sessions } from "../db/schema";
import { hostAuth } from "./credential";
import { HostHub } from "./hub";
import { createHost, revokeHost } from "./keys";

/** 主站和宿主机之间的连接（#91）：测试扮演宿主机守护进程，走真的 WebSocket。 */
describe("宿主机连接", () => {
  let t: TestApp;
  let browser: TestBrowser;
  const clients: TestHostClient[] = [];

  beforeAll(async () => {
    t = await createTestApp({ hosts: true });
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.disconnect()));
    await t.close();
  });

  /** 添加一台宿主机，返回它的密钥。 */
  let hostCount = 0;
  const addHost = async (name = `host-${++hostCount}`) => {
    const result = await createHost(t.db, name, t.clock.now());
    if (!result.ok) throw new Error(result.error);
    return { name, key: result.key };
  };
  const client = (
    key: string,
    options: Partial<ConstructorParameters<typeof TestHostClient>[1]> = {},
  ) => {
    const c = new TestHostClient(t.hostUrl, { key, ...options });
    clients.push(c);
    return c;
  };

  const startSession = async (text = "看看这个仓库") => {
    const res = await browser.post("/api/sessions", { repo: "octo/app", baseBranch: "main", text });
    expect(res.status).toBe(201);
    return (await res.json()) as { shortId: string; status: string; detail: string | null };
  };
  const view = async (shortId: string) =>
    (await (await browser.get(`/api/sessions/${shortId}`)).json()) as {
      status: string;
      detail: string | null;
    };
  const events = async (shortId: string) => {
    const stream = await browser.stream(`/api/sessions/${shortId}/events`);
    const all: SessionEvent[] = [];
    try {
      for (;;) all.push(JSON.parse((await stream.next(150)).data) as SessionEvent);
    } catch {
      // 读到没有新事件为止
    } finally {
      await stream.close();
    }
    return all;
  };
  const settle = async (until: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      await t.hub.flush();
      if (await until()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("等太久了");
  };

  it("没有密钥、密钥错误、被吊销的连接一律拒绝，回的都一样", async () => {
    const revoked = await addHost();
    await revokeHost(t.db, revoked.name, t.clock.now());
    for (const key of ["", "schk_wrong", "something-else", revoked.key]) {
      const result = await client(key, { forwardedFor: "198.51.100.7" }).connect();
      expect(result, key).toEqual({ code: LINK_CLOSE.UNAUTHORIZED });
    }
  });

  it("同一个来源认证失败太多次，过一段时间才能再试；别的来源不受影响", async () => {
    const good = await addHost();
    for (let i = 0; i < 20; i++) {
      await client("schk_wrong", { forwardedFor: "203.0.113.9" }).connect();
    }
    expect(await client(good.key, { forwardedFor: "203.0.113.9" }).connect()).toEqual({
      code: LINK_CLOSE.RATE_LIMITED,
    });
    const other = client(good.key, { forwardedFor: "203.0.113.10" });
    expect(await other.connect()).toMatchObject({ name: good.name });
    await other.disconnect();
    t.clock.advance(61 * 60_000);
    const later = client(good.key, { forwardedFor: "203.0.113.9" });
    expect(await later.connect()).toMatchObject({ name: good.name });
    await later.disconnect();
  });

  it("没有宿主机连着时新会话留在排队中；宿主机连上来以后派过去，事件按序号上报", async () => {
    const session = await startSession();
    expect(session.status).toBe("queued");

    const { key } = await addHost("first");
    const host = client(key);
    const welcome = await host.connect();
    expect(welcome).toMatchObject({ name: "first", protocol: 1, ack: 0 });

    const prepare = await host.command("prepare_sandbox");
    expect(prepare.repos[0]?.fullName).toBe("octo/app");
    await settle(async () => (await view(session.shortId)).detail === "preparing_sandbox");

    host.sendEvent({ type: "sandbox.ready", sessionId: prepare.sessionId });
    const turn = await host.command("start_turn");
    host.sendEvent({
      type: "agent",
      sessionId: prepare.sessionId,
      turnId: turn.turnId,
      event: { type: "turn.started" },
    });
    host.sendEvent({
      type: "agent",
      sessionId: prepare.sessionId,
      turnId: turn.turnId,
      event: { type: "message", text: "看完了。" },
    });
    host.sendEvent({
      type: "agent",
      sessionId: prepare.sessionId,
      turnId: turn.turnId,
      event: { type: "turn.ended", reason: "completed" },
    });
    await settle(async () => (await view(session.shortId)).status === "waiting");
    expect((await events(session.shortId)).filter((e) => e.type === "message")).toHaveLength(1);
    // 主站确认处理完了，宿主机的补发队列清空
    await host.until(() => host.unackedCount === 0);
    await host.disconnect();
  });

  /** 一台连着的宿主机，加一个已经在它上面跑起来的会话（回合在进行中）。 */
  const running = async () => {
    const { name, key } = await addHost();
    const host = client(key);
    await host.connect();
    const session = await startSession();
    const prepare = await host.command("prepare_sandbox");
    host.sendEvent({ type: "sandbox.ready", sessionId: prepare.sessionId });
    const turn = await host.command("start_turn");
    host.sendEvent({
      type: "agent",
      sessionId: prepare.sessionId,
      turnId: turn.turnId,
      event: { type: "turn.started" },
    });
    await settle(async () => (await view(session.shortId)).detail === null);
    return { name, key, host, shortId: session.shortId, sessionId: prepare.sessionId, turn };
  };
  const say = (r: Awaited<ReturnType<typeof running>>, text: string, seq?: number) =>
    r.host.sendEvent(
      {
        type: "agent",
        sessionId: r.sessionId,
        turnId: r.turn.turnId,
        event: { type: "message", text },
      },
      seq,
    );
  const messages = async (shortId: string) =>
    (await events(shortId)).flatMap((e) => (e.type === "message" ? [e.text] : []));

  it("重复的帧只处理一次", async () => {
    const r = await running();
    const seq = say(r, "第一句");
    r.host.send({
      seq,
      ack: r.host.received,
      event: {
        type: "agent",
        sessionId: r.sessionId,
        turnId: r.turn.turnId,
        event: { type: "message", text: "第一句" },
      },
    });
    say(r, "第二句");
    await settle(async () => (await messages(r.shortId)).length === 2);
    expect(await messages(r.shortId)).toEqual(["第一句", "第二句"]);
    await r.host.disconnect();
  });

  it("断线重连：主站补发宿主机没确认的命令；宿主机再发一遍主站处理过的事件，不重复", async () => {
    const r = await running();
    const seq = say(r, "断线前");
    await r.host.until(() => r.host.unackedCount === 0);
    await r.host.disconnect();
    await settle(async () => t.hub.status().find((h) => h.name === r.name)?.connected === false);

    // 断线期间管理员插了一句话
    const injected = await browser.post(`/api/sessions/${r.shortId}/messages`, {
      text: "顺便看看测试",
      mode: "now",
    });
    expect(injected.status).toBe(202);
    await t.hub.flush();

    const welcome = await r.host.connect();
    // 主站告诉宿主机它处理到了哪一帧
    expect((welcome as { ack: number }).ack).toBeGreaterThanOrEqual(seq);
    // 主站补发了这句话
    expect((await r.host.command("inject_message")).text).toBe("顺便看看测试");
    // 宿主机不知道主站处理过没有，再发一遍同一个序号：不重复
    say(r, "断线前", seq);
    say(r, "重连后");
    await settle(async () => (await messages(r.shortId)).includes("重连后"));
    expect(await messages(r.shortId)).toEqual(["断线前", "重连后"]);
    await r.host.disconnect();
  });

  it("宿主机连着时主站发的命令立即送到；断线期间发的重连以后补上，按原来的顺序", async () => {
    const r = await running();
    await r.host.disconnect();
    await settle(async () => t.hub.status().find((h) => h.name === r.name)?.connected === false);
    const before = r.host.commands.length;
    await browser.post(`/api/sessions/${r.shortId}/messages`, { text: "插一句", mode: "now" });
    await browser.post(`/api/sessions/${r.shortId}/stop`);
    await t.hub.flush();
    expect(r.host.commands.length).toBe(before);

    await r.host.connect();
    await r.host.until(() => r.host.commands.length >= before + 2);
    expect(r.host.commands.slice(before).map((c) => c.command.type)).toEqual([
      "inject_message",
      "stop_turn",
    ]);
    await r.host.disconnect();
  });

  it("宿主机重启（守护进程换了一个）：序号从头数，主站照收", async () => {
    const r = await running();
    say(r, "重启前");
    await r.host.until(() => r.host.unackedCount === 0);
    await r.host.disconnect();
    r.host.restart();
    const welcome = await r.host.connect();
    expect(welcome).toMatchObject({ ack: 0 });
    say(r, "重启后");
    await settle(async () => (await messages(r.shortId)).includes("重启后"));
    expect(await messages(r.shortId)).toEqual(["重启前", "重启后"]);
    await r.host.disconnect();
  });

  it("同一把密钥又连上来一条：后连上的顶掉先连上的", async () => {
    const { key, name } = await addHost();
    const first = client(key);
    await first.connect();
    const second = client(key);
    expect(await second.connect()).toMatchObject({ name });
    await first.until(() => first.closed !== undefined);
    expect(first.closed?.code).toBe(LINK_CLOSE.REPLACED);
    expect(t.hub.status().find((h) => h.name === name)?.connected).toBe(true);
    await second.disconnect();
  });

  it("一台宿主机不能替别的宿主机上的会话上报事件", async () => {
    const r = await running();
    const other = client((await addHost()).key);
    await other.connect();
    other.sendEvent({
      type: "agent",
      sessionId: r.sessionId,
      turnId: r.turn.turnId,
      event: { type: "message", text: "冒充的" },
    });
    other.sendEvent({
      type: "sandbox.failed",
      sessionId: r.sessionId,
      error: { code: "internal" },
    });
    // 照样确认（不然会一直补发），但不处理
    await other.until(() => other.unackedCount === 0);
    expect(await messages(r.shortId)).not.toContain("冒充的");
    expect((await view(r.shortId)).status).toBe("running");
    await other.disconnect();
    await r.host.disconnect();
  });

  it("不认识的事件类型（比主站新）和格式不对的事件：确认、忽略；外层格式不对的帧断开连接", async () => {
    const r = await running();
    r.host.sendEvent({ type: "sandbox.hibernated", sessionId: r.sessionId } as never);
    r.host.sendEvent({ type: "agent", sessionId: r.sessionId } as never);
    await r.host.until(() => r.host.unackedCount === 0);
    expect((await view(r.shortId)).status).toBe("running");

    r.host.send("不是 JSON");
    await r.host.until(() => r.host.closed !== undefined);
    expect(r.host.closed?.code).toBe(LINK_CLOSE.BAD_FRAME);
  });

  it("协议版本说不到一起的宿主机连得上，但不接新会话；差一个版本的照常", async () => {
    // 先让别的宿主机都断开，新会话只能看这一台
    await Promise.all(clients.map((c) => c.disconnect()));
    await settle(async () => t.hub.available() === false);

    const newer = client((await addHost()).key, { protocol: 3, minProtocol: 2 });
    expect(await newer.connect()).toMatchObject({ protocol: null });
    expect(t.hub.available()).toBe(false);
    const session = await startSession("版本不对");
    expect(session.status).toBe("queued");
    await new Promise((r) => setTimeout(r, 100));
    expect(newer.commands).toEqual([]);

    const nextVersion = client((await addHost()).key, { protocol: 2, minProtocol: 1 });
    expect(await nextVersion.connect()).toMatchObject({ protocol: 1 });
    const prepare = await nextVersion.command("prepare_sandbox");
    const [row] = await t.db
      .select({ shortId: sessions.shortId })
      .from(sessions)
      .where(eq(sessions.id, prepare.sessionId));
    expect(row?.shortId).toBe(session.shortId);
    await newer.disconnect();
    await nextVersion.disconnect();
  });

  it("吊销：已有的连接立即断开，再连被拒绝，凭据作废，名下运行中的会话马上标为失败", async () => {
    const r = await running();
    const token = r.host.credential?.token as string;
    expect(t.hub.verifyCredential(token)?.name).toBe(r.name);

    await revokeHost(t.db, r.name, t.clock.now());
    await t.hub.checkRevocations();
    await r.host.until(() => r.host.closed !== undefined);
    expect(r.host.closed?.code).toBe(LINK_CLOSE.UNAUTHORIZED);
    expect(t.hub.verifyCredential(token)).toBeUndefined();
    await settle(async () => (await view(r.shortId)).status === "failed");
    const failed = (await events(r.shortId)).findLast((e) => e.type === "status");
    expect(failed).toMatchObject({ status: "failed", error: { code: "sandbox_unavailable" } });

    expect(await client(r.key).connect()).toEqual({ code: LINK_CLOSE.UNAUTHORIZED });
  });

  it("宿主机断线超过设置的时长（默认 2 分钟）才把它上面运行中的会话标为失败；时长可以改", async () => {
    const r = await running();
    await r.host.disconnect();
    await settle(async () => t.hub.status().find((h) => h.name === r.name)?.connected === false);

    t.clock.advance(119_000);
    await t.hub.tick();
    expect((await view(r.shortId)).status).toBe("running");

    // 管理员把时长改成 10 分钟：2 分钟过了也不标
    const put = await browser.request("/api/settings/host-offline-grace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seconds: 600 }),
    });
    expect(put.status).toBe(200);
    t.clock.advance(2_000);
    await t.hub.tick();
    expect((await view(r.shortId)).status).toBe("running");

    // 重连得上就接着跑
    await r.host.connect();
    t.clock.advance(600_000);
    await t.hub.tick();
    expect((await view(r.shortId)).status).toBe("running");

    await r.host.disconnect();
    await settle(async () => t.hub.status().find((h) => h.name === r.name)?.connected === false);
    t.clock.advance(601_000);
    await t.hub.tick();
    await settle(async () => (await view(r.shortId)).status === "failed");

    // 改回默认，免得影响后面的测试
    await browser.request("/api/settings/host-offline-grace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seconds: 120 }),
    });
  });

  it("宿主机凭据：连上时下发，过一半有效期换新的；中间件认得出是哪台，过期、吊销、乱写的都回 401", async () => {
    const { key, name } = await addHost();
    const host = client(key);
    await host.connect();
    const app = new Hono()
      .use("/host/*", hostAuth(t.hub))
      .get("/host/whoami", (c) =>
        c.json({ name: (c.get as (k: "host") => { name: string })("host").name }),
      );
    const call = (token?: string) =>
      app.request("/host/whoami", token ? { headers: { authorization: `Bearer ${token}` } } : {});

    const first = host.credential?.token as string;
    expect(await (await call(first)).json()).toEqual({ name });
    expect((await call()).status).toBe(401);
    expect((await call("not-a-real-credential")).status).toBe(401);

    // 过了一半有效期：主站发来一张新的，旧的到期前照样能用
    t.clock.advance(31 * 60_000);
    await t.hub.tick();
    await host.until(() => host.credential?.token !== first);
    const second = host.credential?.token as string;
    expect((await call(first)).status).toBe(200);
    expect((await call(second)).status).toBe(200);

    // 旧的过期了
    t.clock.advance(30 * 60_000);
    await t.hub.tick();
    expect((await call(first)).status).toBe(401);
    expect((await call(second)).status).toBe(200);
    await host.disconnect();
  });

  it("宿主机定时上报的负载，给运行状况看", async () => {
    const { key, name } = await addHost();
    const host = client(key, { version: "1.2.3" });
    await host.connect();
    const report = {
      load: 0.5,
      cpus: 8,
      memoryAvailable: 4e9,
      memoryTotal: 16e9,
      diskAvailable: 1e11,
      diskTotal: 5e11,
      sandboxes: 2,
      diskQuota: false,
    };
    host.sendReport(report);
    await host.until(() => t.hub.status().find((h) => h.name === name)?.report !== undefined);
    expect(t.hub.status().find((h) => h.name === name)).toMatchObject({
      connected: true,
      protocol: 1,
      version: "1.2.3",
      report,
    });
    await host.disconnect();
  });
});

describe("主站重启", () => {
  it("同一个宿主机进程重连上来：主站从库里接上序号，处理过的事件不重复处理，会话接着跑", async () => {
    const database = await createTestDatabase();
    const first = await createTestApp({ hosts: true, databaseUrl: database.url });
    const { browser } = await first.adminWithGitHub("octo", "octo/app");
    const created = await createHost(first.db, "steady", first.clock.now());
    if (!created.ok) throw new Error(created.error);
    const host = new TestHostClient(first.hostUrl, { key: created.key });
    await host.connect();
    const res = await browser.post("/api/sessions", {
      repo: "octo/app",
      baseBranch: "main",
      text: "开始",
    });
    const { shortId } = (await res.json()) as { shortId: string };
    const prepare = await host.command("prepare_sandbox");
    host.sendEvent({ type: "sandbox.ready", sessionId: prepare.sessionId });
    const turn = await host.command("start_turn");
    const say = (text: string, seq?: number) =>
      host.sendEvent(
        {
          type: "agent",
          sessionId: prepare.sessionId,
          turnId: turn.turnId,
          event: { type: "message", text },
        },
        seq,
      );
    const seq = say("重启前");
    await host.until(() => host.unackedCount === 0);
    await host.disconnect();
    await first.hub.stop();

    // 主站重启：新的进程，同一个库。宿主机还是那个进程：同一个标识，接着自己的序号
    const second = await createTestApp({ hosts: true, databaseUrl: database.url });
    const steady = new TestHostClient(second.hostUrl, {
      key: created.key,
      instance: host.instance,
    });
    const welcome = await steady.connect(host.received);
    expect((welcome as { ack: number }).ack).toBe(seq);
    // 宿主机不知道主站处理过没有，再发一遍；再接着说
    steady.sendEvent(
      {
        type: "agent",
        sessionId: prepare.sessionId,
        turnId: turn.turnId,
        event: { type: "message", text: "重启前" },
      },
      seq,
    );
    steady.sendEvent(
      {
        type: "agent",
        sessionId: prepare.sessionId,
        turnId: turn.turnId,
        event: { type: "message", text: "重启后" },
      },
      seq + 1,
    );
    await steady.until(() => steady.unackedCount === 0);
    await second.hub.flush();
    const login = await second.admin();
    const stream = await login.stream(`/api/sessions/${shortId}/events`);
    const texts: string[] = [];
    try {
      for (;;) {
        const e = JSON.parse((await stream.next(150)).data) as SessionEvent;
        if (e.type === "message") texts.push(e.text);
      }
    } catch {
      // 读完
    } finally {
      await stream.close();
    }
    expect(texts).toEqual(["重启前", "重启后"]);
    await steady.disconnect();
    await second.close();
    await first.close();
    await database.drop();
  });
});
