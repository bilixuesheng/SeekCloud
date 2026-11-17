import type { SessionEvent } from "@seekcloud/protocol";
import { describeIdentityContract, TestBrowser } from "@seekcloud/site/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDownstreamExample } from "./start";

type Example = Awaited<ReturnType<typeof startDownstreamExample>>;

/** 走真的 HTTP 的浏览器。跳转不自己跟，和 TestBrowser 在进程内调用时一样。 */
const httpBrowser = (example: Example) =>
  new TestBrowser({
    request: (path, init) => fetch(`${example.url}${path}`, { ...init, redirect: "manual" }),
  });

describe("最小下游：换了身份来源和设置规则的主站", () => {
  let example: Example;
  let browser: TestBrowser;

  beforeAll(async () => {
    example = await startDownstreamExample();
    browser = httpBrowser(example);
    await example.identity.signIn(browser, await example.identity.addUser("下游的用户"));
    await example.linkGitHub(browser, "downstream", "downstream/app");
  });
  afterAll(() => example.close());

  it("登录、发起会话走一遍：新会话用下游定的默认思考强度，Agent 回了话", async () => {
    const res = await browser.post("/api/sessions", {
      repo: "downstream/app",
      baseBranch: "main",
      text: "看看这个仓库",
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as { shortId: string; effort: string };
    expect(session.effort).toBe("low");
    await example.host.idle();

    const stream = await browser.stream(`/api/sessions/${session.shortId}/events`);
    const seen: SessionEvent[] = [];
    try {
      for (;;) seen.push(JSON.parse((await stream.next(300)).data) as SessionEvent);
    } catch {
      // 读到没有新事件为止
    } finally {
      await stream.close();
    }
    expect(seen.some((e) => e.type === "message")).toBe(true);
  });

  it("下游的设置规则生效：AI 标识不能关", async () => {
    const res = await browser.request("/api/settings/ai-labels", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature: false, commitTrailer: true }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("setting_locked");
  });

  it("下游自己的表和接口：登录状态问身份来源，数据按人分开", async () => {
    expect((await httpBrowser(example).get("/api/example/notes")).status).toBe(401);
    expect((await browser.post("/api/example/notes", { body: "第一条" })).status).toBe(204);
    expect(await (await browser.get("/api/example/notes")).json()).toEqual({ notes: ["第一条"] });

    const other = await example.identity.signIn(
      httpBrowser(example),
      await example.identity.addUser("另一个人"),
    );
    expect(await (await other.get("/api/example/notes")).json()).toEqual({ notes: [] });
  });
});

describeIdentityContract("最小下游的身份来源", async () => {
  const example = await startDownstreamExample();
  const userId = await example.identity.addUser("契约");
  return {
    driver: {
      browser: () => httpBrowser(example),
      logIn: (browser) => example.identity.signIn(browser, userId),
      logOut: async (browser) => {
        await browser.post("/api/auth/logout");
      },
    },
    close: example.close,
  };
});
