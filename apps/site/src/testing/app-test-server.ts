import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { AgentEvent, RepoDiff } from "@seekcloud/protocol";
import { desc, eq } from "drizzle-orm";
import { sessionRepos, sessions, turns } from "../server/db/schema";
import { createTemplateDatabase, dropTemplateDatabase } from "./database";
import { createTestApp } from "./test-app";

/**
 * 给安卓 App 的界面测试（#205）起几台假主站：每台是一个 createTestApp() 的主站（假 GitHub、假宿主机），
 * 只开接口，监听所有网卡（模拟器经 10.0.2.2 连到这台机器），管理员密码已经设好。
 * 每台起好以后打印一行 JSON：{ "port": 端口, "password": 管理员密码 }，全部起好以后打印 "ready"。
 *
 * 只在这里有的控制接口（真的主站上没有）：`POST /__test/next-turn` 让假宿主机的下一个回合按给的事件回放
 * （`{ "events": [...] }`，协议包的 AgentEvent），`{ "failSandbox": true }` 让下一次准备沙箱失败（会话变成"失败"），
 * `{ "hold": true }` 让假宿主机不再回复（新会话一直停在"正在准备沙箱"），`{ "hold": false }` 恢复。
 * 界面测试用它造出等你输入、失败、Agent 正在工作这些状态。
 * `POST /__test/diff`（`{ "shortId": ..., "repos": [...] }`，协议包的 RepoDiff）替假宿主机给这个会话最近的回合
 * 报一份对比基础分支的改动（改动面板用）；会话还没有这些仓库时一起挂上（假主站没关联 GitHub，发起的会话不带仓库）。
 *
 * 用法（在 apps/site 里）：pnpm app-test-server [台数，默认 2]；要一个 PostgreSQL（同主站的测试）。
 */
const count = Number(process.argv[2] ?? 2);

await createTemplateDatabase();
const closers: (() => Promise<void>)[] = [];
for (let i = 0; i < count; i++) {
  const t = await createTestApp();
  // 第一次调用时设置管理员密码
  await t.admin();
  // 照 preview-server.ts：把请求转给进程内的主站
  const fetch = async (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname === "/__test/next-turn" && req.method === "POST") {
      const body = (await req.json()) as {
        events?: AgentEvent[];
        failSandbox?: boolean;
        hold?: boolean;
      };
      if (body.events) t.host.script(...body.events);
      if (body.failSandbox) t.host.failNextSandbox({ code: "sandbox_unavailable" });
      // hold：假宿主机不再回复（新会话一直停在"正在准备沙箱"，测 Agent 工作时的输入框）；false 恢复
      if (body.hold !== undefined) t.host.manual = body.hold;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__test/diff" && req.method === "POST") {
      const body = (await req.json()) as { shortId: string; repos: RepoDiff[] };
      const [row] = await t.db
        .select({ sessionId: sessions.id, turnId: turns.id })
        .from(sessions)
        .innerJoin(turns, eq(turns.sessionId, sessions.id))
        .where(eq(sessions.shortId, body.shortId))
        .orderBy(desc(turns.number))
        .limit(1);
      if (!row) return new Response(null, { status: 404 });
      // 改动面板只列会话自己的仓库
      const attached = await t.db
        .select({ fullName: sessionRepos.fullName })
        .from(sessionRepos)
        .where(eq(sessionRepos.sessionId, row.sessionId));
      for (const repo of body.repos) {
        if (attached.some((a) => a.fullName === repo.fullName)) continue;
        await t.db.insert(sessionRepos).values({
          sessionId: row.sessionId,
          position: attached.length,
          fullName: repo.fullName,
          baseBranch: repo.baseBranch,
          branch: `seekcloud/${body.shortId}`,
          access: "push",
        });
        attached.push({ fullName: repo.fullName });
      }
      await t.host.emit({ type: "workspace.diff", ...row, repos: body.repos });
      return new Response(null, { status: 204 });
    }
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer();
    return t.request(url.pathname + url.search, {
      method: req.method,
      headers: req.headers,
      body,
      signal: req.signal,
    });
  };
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch, port: 0, hostname: "0.0.0.0" }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  console.log(JSON.stringify({ port, password: t.adminPassword }));
  closers.push(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    await t.close();
  });
}
console.log("ready");

const stop = async () => {
  for (const close of closers) await close();
  await dropTemplateDatabase();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
