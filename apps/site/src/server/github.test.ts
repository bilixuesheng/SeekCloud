import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeGitHub } from "../testing/fake-github";
import { createTestApp, type TestApp } from "../testing/test-app";
import type { TestBrowser } from "../testing/test-browser";

type FakeUser = ReturnType<FakeGitHub["addUser"]>;

/** 点"关联 GitHub"，在 GitHub 上授权，再跳回来。返回跳回来那一步的响应。 */
async function linkGitHub(t: TestApp, browser: TestBrowser, user: FakeUser, next?: string) {
  const start = await browser.get(
    `/api/auth/github/start${next ? `?next=${encodeURIComponent(next)}` : ""}`,
  );
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location") as string).searchParams.get("state");
  return browser.get(`/api/auth/github/callback?code=${t.github.authorize(user)}&state=${state}`);
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("关联 GitHub", () => {
  let t: TestApp;
  let admin: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.admin();
  });
  afterAll(() => t.close());

  it("还没关联时，状态里给出安装 App 的地址，也没有 GitHub 用户名", async () => {
    expect(await json(await admin.get("/api/github/status"))).toEqual({
      connected: false,
      installUrl: t.github.installUrl,
    });
    expect(await json(await admin.get("/api/me"))).toMatchObject({ githubLogin: null });
  });

  it("授权后关联到管理员，回到原来的页面；浏览器 Cookie 里没有 GitHub 令牌", async () => {
    const octo = t.github.addUser({ login: "octo" });

    const callback = await linkGitHub(t, admin, octo, "/settings");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/settings");
    expect(callback.headers.getSetCookie().join("\n")).not.toMatch(/gho_|ghr_/);
    expect(await json(await admin.get("/api/github/status"))).toMatchObject({
      connected: true,
      login: "octo",
    });
    expect(await json(await admin.get("/api/me"))).toMatchObject({ githubLogin: "octo" });
  });

  it("再授权另一个 GitHub 账号：换成新的", async () => {
    const other = t.github.addUser({ login: "octo-2" });

    expect((await linkGitHub(t, admin, other)).headers.get("location")).toBe("/");

    expect(await json(await admin.get("/api/github/status"))).toMatchObject({
      connected: true,
      login: "octo-2",
    });
  });

  it("解除关联：GitHub 令牌也删掉，显示为未关联；没关联时再解除：404", async () => {
    expect((await admin.post("/api/github/unlink", {})).status).toBe(204);

    expect(await json(await admin.get("/api/github/status"))).toMatchObject({ connected: false });
    expect(await json(await admin.get("/api/me"))).toMatchObject({ githubLogin: null });
    expect((await admin.post("/api/github/unlink", {})).status).toBe(404);
    expect((await t.browser().post("/api/github/unlink", {})).status).toBe(401);
  });

  it("没登录就跳回来：拒绝，不关联", async () => {
    const stranger = t.github.addUser({ login: "stranger" });

    const callback = await linkGitHub(t, t.browser(), stranger);

    expect(callback.headers.get("location")).toBe("/?github=failed");
    expect(await json(await admin.get("/api/github/status"))).toMatchObject({ connected: false });
  });

  it("没先点关联（state 对不上）就跳回来：拒绝", async () => {
    const forged = t.github.addUser({ login: "forged" });

    const res = await admin.get(
      `/api/auth/github/callback?code=${t.github.authorize(forged)}&state=x`,
    );

    expect(res.headers.get("location")).toBe("/?github=failed");
    expect(await json(await admin.get("/api/github/status"))).toMatchObject({ connected: false });
  });

  it("next 只能是站内的几个页面，防止跳到别的网站", async () => {
    const user = t.github.addUser({ login: "redirect" });

    const callback = await linkGitHub(t, admin, user, "//evil.example.com");

    expect(callback.headers.get("location")).toBe("/");
  });
});

describe("仓库和分支", () => {
  let t: TestApp;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    const admin = await t.adminWithGitHub("dev", "dev/app");
    t.github.install(admin.user, { fullName: "dev/site", private: false });
    t.github.addPublicRepo("vercel/next.js");
    t.github.setBranches("dev/app", ["main", "feature/login"]);
    browser = admin.browser;
  });
  afterAll(() => t.close());

  it("列出装了 App 的仓库，可以推送", async () => {
    const res = await json(await browser.get("/api/github/repos"));

    expect(res.repos).toEqual([
      { fullName: "dev/app", private: true, defaultBranch: "main", canPush: true },
      { fullName: "dev/site", private: false, defaultBranch: "main", canPush: true },
    ]);
  });

  it("搜索时也包括公开仓库，公开仓库只读", async () => {
    const res = await json(await browser.get("/api/github/repos?q=next"));

    expect(res.repos).toEqual([
      { fullName: "vercel/next.js", private: false, defaultBranch: "main", canPush: false },
    ]);
  });

  it("列出仓库的分支", async () => {
    const res = await json(await browser.get("/api/github/repos/dev/app/branches"));

    expect(res.branches).toEqual(["main", "feature/login"]);
  });

  it("访问令牌过期后自动刷新，用户感觉不到", async () => {
    t.clock.advance(9 * 3_600_000);

    const res = await browser.get("/api/github/repos");

    expect(res.status).toBe(200);
    expect(t.github.refreshCount).toBe(1);
  });

  it("刷新令牌也过期了：显示为未关联，要重新授权", async () => {
    t.clock.advance(200 * 24 * 3_600_000);
    // 登录状态 30 天也过期了，先重新登录。
    browser = await t.admin();

    expect((await browser.get("/api/github/repos")).status).toBe(409);
    expect(await json(await browser.get("/api/github/status"))).toMatchObject({ connected: false });
  });
});

describe("GitHub webhook", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("签名对的 webhook 收下，签名不对的拒绝", async () => {
    const body = JSON.stringify({ action: "created", installation: { id: 1 } });
    const post = (signature: string) =>
      t.request("/api/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-hub-signature-256": signature,
        },
        body,
      });

    expect((await post(t.github.sign(body))).status).toBe(204);
    expect((await post("sha256=bad")).status).toBe(401);
  });

  /** GitHub 发来一条 pull_request webhook（签好名）。 */
  const pullRequestEvent = (pr: {
    repo: string;
    branch: string;
    number: number;
    state: "open" | "closed";
    merged?: boolean;
    draft?: boolean;
    updatedAt: string;
    /** 分支所在的仓库，默认就是 repo；null 表示那个仓库已经删了。 */
    headRepo?: string | null;
  }) => {
    const body = JSON.stringify({
      action: "edited",
      repository: { full_name: pr.repo },
      pull_request: {
        number: pr.number,
        state: pr.state,
        merged: pr.merged ?? false,
        draft: pr.draft ?? false,
        updated_at: pr.updatedAt,
        head: {
          ref: pr.branch,
          repo: pr.headRepo === null ? null : { full_name: pr.headRepo ?? pr.repo },
        },
      },
    });
    return t.request("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": t.github.sign(body),
      },
      body,
    });
  };

  it("会话分支上的 PR：打开、草稿、合并都记下来，会话里能看到；乱序到达的旧消息不覆盖新的", async () => {
    const { browser } = await t.adminWithGitHub("pr-owner", "pr-owner/app");
    const created = await browser.post("/api/sessions", {
      repo: "pr-owner/app",
      baseBranch: "main",
      text: "修个 bug",
    });
    const { shortId } = (await created.json()) as { shortId: string };
    const repoOf = async () =>
      (
        (await json(await browser.get(`/api/sessions/${shortId}`))).repos as Array<{
          pullRequest: unknown;
        }>
      )[0]?.pullRequest;
    const branch = `seekcloud/${shortId}`;
    expect(await repoOf()).toBeNull();

    await pullRequestEvent({
      repo: "pr-owner/app",
      branch,
      number: 12,
      state: "open",
      draft: true,
      updatedAt: "2026-11-01T10:00:00Z",
    });
    expect(await repoOf()).toEqual({ number: 12, state: "draft" });

    await pullRequestEvent({
      repo: "pr-owner/app",
      branch,
      number: 12,
      state: "closed",
      merged: true,
      updatedAt: "2026-11-01T12:00:00Z",
    });
    // 晚到的旧消息（ready_for_review）不能把"已合并"改回"打开"。
    await pullRequestEvent({
      repo: "pr-owner/app",
      branch,
      number: 12,
      state: "open",
      updatedAt: "2026-11-01T11:00:00Z",
    });
    expect(await repoOf()).toEqual({ number: 12, state: "merged" });
  });

  it("同一个分支上关掉一个 PR 再开一个：显示新的，旧 PR 后来的变化不换回去", async () => {
    const { browser } = await t.adminWithGitHub("pr-reopen", "pr-reopen/app");
    const created = await browser.post("/api/sessions", {
      repo: "pr-reopen/app",
      baseBranch: "main",
      text: "重构",
    });
    const { shortId } = (await created.json()) as { shortId: string };
    const branch = `seekcloud/${shortId}`;
    const repoOf = async () =>
      (
        (await json(await browser.get(`/api/sessions/${shortId}`))).repos as Array<{
          pullRequest: unknown;
        }>
      )[0]?.pullRequest;

    const event = { repo: "pr-reopen/app", branch };
    await pullRequestEvent({
      ...event,
      number: 7,
      state: "closed",
      updatedAt: "2026-11-01T10:00:00Z",
    });
    await pullRequestEvent({
      ...event,
      number: 8,
      state: "open",
      updatedAt: "2026-11-01T11:00:00Z",
    });
    // 有人后来在关掉的 #7 上改了标题：它的 updated_at 更新，但不该把会话换回 #7。
    await pullRequestEvent({
      ...event,
      number: 7,
      state: "closed",
      updatedAt: "2026-11-01T12:00:00Z",
    });
    expect(await repoOf()).toEqual({ number: 8, state: "open" });

    // 分支所在的仓库已经删了：不知道是哪个仓库的同名分支，不认。
    await pullRequestEvent({
      ...event,
      number: 9,
      state: "open",
      headRepo: null,
      updatedAt: "2026-11-01T13:00:00Z",
    });
    expect(await repoOf()).toEqual({ number: 8, state: "open" });
  });

  it("不是会话分支的 PR、别的仓库同名分支的 PR：不影响会话", async () => {
    const { browser } = await t.adminWithGitHub("pr-other", "pr-other/app");
    const created = await browser.post("/api/sessions", {
      repo: "pr-other/app",
      baseBranch: "main",
      text: "加个功能",
    });
    const { shortId } = (await created.json()) as { shortId: string };

    await pullRequestEvent({
      repo: "someone/else",
      branch: `seekcloud/${shortId}`,
      number: 3,
      state: "open",
      updatedAt: "2026-11-01T10:00:00Z",
    });
    await pullRequestEvent({
      repo: "pr-other/app",
      branch: "feature/login",
      number: 4,
      state: "open",
      updatedAt: "2026-11-01T10:00:00Z",
    });

    const session = await json(await browser.get(`/api/sessions/${shortId}`));
    expect((session.repos as Array<{ pullRequest: unknown }>)[0]?.pullRequest).toBeNull();
  });
});

describe("GitHub 出问题的时候", () => {
  let t: TestApp;
  let user: FakeUser;
  let browser: TestBrowser;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser, user } = await t.adminWithGitHub("edge", "edge/app"));
    t.github.install(user, { fullName: "edge/lib", private: false });
    t.github.addPublicRepo("edge/lib");
  });
  afterAll(() => t.close());

  it("令牌过期后同时来很多请求：只刷新一次，全部成功", async () => {
    // 先让数据库连接池里有足够的连接，下面的请求才会真的同时跑。
    await Promise.all(Array.from({ length: 8 }, () => browser.get("/api/github/status")));
    t.clock.advance(9 * 3_600_000);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => browser.get("/api/github/repos")),
    );

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(t.github.refreshCount).toBe(1);
  });

  it("搜到的公开仓库如果装了 App，按可推送显示", async () => {
    const res = await json(await browser.get("/api/github/repos?q=lib"));

    expect(res.repos).toEqual([
      { fullName: "edge/lib", private: false, defaultBranch: "main", canPush: true },
    ]);
  });

  it("在 GitHub 上卸载了某个仓库的 App，列表里马上就没有了", async () => {
    t.github.uninstall(user, "edge/app");

    const res = await json(await browser.get("/api/github/repos"));

    expect((res.repos as Array<{ fullName: string }>).map((r) => r.fullName)).toEqual(["edge/lib"]);
  });

  it("GitHub 暂时访问不了：返回 502，关联状态不变", async () => {
    t.github.failNext();

    const res = await browser.get("/api/github/repos");

    expect(res.status).toBe(502);
    expect((await json(res)).error).toMatchObject({ code: "github_unavailable" });
    expect(await json(await browser.get("/api/github/status"))).toMatchObject({ connected: true });
  });

  it("用户在 GitHub 上撤销了授权：返回 409，显示为未关联", async () => {
    t.github.revoke(user);

    const res = await browser.get("/api/github/repos");

    expect(res.status).toBe(409);
    expect(await json(await browser.get("/api/github/status"))).toMatchObject({ connected: false });
  });
});
