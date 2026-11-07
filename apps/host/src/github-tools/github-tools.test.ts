import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProxyCa } from "../git-proxy/ca";
import { createGitProxy } from "../git-proxy/proxy";
import { GitSessions } from "../git-proxy/sessions";
import { loadSigningKey } from "../signing/sshsig";
import { GitHubClient } from "./client";
import { FOOTER_LINE } from "./footer";
import { withTrailer } from "./tools";

const USER_TOKEN = "gho_user_token";
const SESSION_TOKEN = "sess_tools";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  accept: string | undefined;
  features: string | undefined;
  body: unknown;
}

type Handler = (req: Recorded) => {
  status?: number;
  json?: unknown;
  text?: string;
  location?: string;
};

/** 假的 GitHub API：按"方法 路径"找处理函数，记下每个请求。 */
function fakeApi() {
  const routes = new Map<string, Handler>();
  const requests: Recorded[] = [];
  let graphql: (query: string, variables: Record<string, unknown>) => unknown = () => ({
    data: {},
  });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fake");
    const recorded: Recorded = {
      method: req.method ?? "GET",
      path: url.pathname.replace(/^\/api/, ""),
      query: url.searchParams,
      auth: req.headers.authorization,
      accept: req.headers.accept,
      features: req.headers["graphql-features"] as string | undefined,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(recorded);
    if (recorded.path === "/graphql") {
      const { query, variables } = recorded.body as {
        query: string;
        variables: Record<string, unknown>;
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(graphql(query, variables)));
      return;
    }
    const handler = routes.get(`${recorded.method} ${recorded.path}`);
    const out = handler ? handler(recorded) : { status: 404, json: { message: "Not Found" } };
    if (out.location) {
      res.writeHead(302, { location: out.location });
      res.end();
      return;
    }
    res.writeHead(out.status ?? 200, {
      "content-type": out.text !== undefined ? "text/plain" : "application/json",
    });
    res.end(out.text ?? JSON.stringify(out.json ?? {}));
  });
  return {
    server,
    requests,
    route: (key: string, handler: Handler) => routes.set(key, handler),
    onGraphql: (fn: typeof graphql) => {
      graphql = fn;
    },
  };
}

const api = fakeApi();
let apiBase: string;
let proxy: http.Server;
let mcpUrl: string;
const sessions = new GitSessions();

beforeAll(async () => {
  await new Promise<void>((done) => api.server.listen(0, "127.0.0.1", done));
  apiBase = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/api`;
  proxy = createGitProxy({
    sessions,
    ca: new ProxyCa(mkdtempSync(join(tmpdir(), "proxy-ca-"))),
    signingKey: loadSigningKey(
      generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      "seekcloud-bot",
    ),
    signerEmail: "bot@seekcloud.test",
    upstreams: { "api.github.com": apiBase },
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  mcpUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/mcp`;
  sessions.register({
    sessionId: "s1",
    sessionToken: SESSION_TOKEN,
    repos: [
      { fullName: "octo/app", access: "push" },
      { fullName: "someone/lib", access: "read" },
    ],
  });
  sessions.setGitHubToken("s1", USER_TOKEN);
});

afterAll(async () => {
  await new Promise<void>((done) => proxy.close(() => done()));
  await new Promise<void>((done) => api.server.close(() => done()));
});

beforeEach(() => {
  api.requests.length = 0;
});

let nextId = 1;
async function rpc(body: unknown, token = SESSION_TOKEN) {
  return fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

/** 调一个工具，返回结果的文字和是不是出错。 */
async function call(name: string, args: Record<string, unknown>) {
  const res = await rpc({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = (await res.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { text: body.result.content[0]?.text ?? "", isError: body.result.isError === true };
}

const footer = `\n\n---\n${FOOTER_LINE}`;

describe("MCP 协议", () => {
  it("初始化、列出工具；通知回 202；没有令牌或令牌不对回 401；GET 回 405", async () => {
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "dsh", version: "1" },
      },
    });
    expect(await init.json()).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "seekcloud-github" },
      },
    });
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const list = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string } }> };
    };
    const names = list.result.tools.map((t) => t.name);
    // 验收清单：读文件和分支、提交、issue、评论、PR、review、线程、CI、自动合并、更新分支、Copilot、合并、搜索。
    for (const name of [
      "get_file_contents",
      "list_branches",
      "list_commits",
      "issue_read",
      "issue_write",
      "add_issue_comment",
      "create_pull_request",
      "update_pull_request",
      "pull_request_read",
      "pull_request_review_write",
      "add_comment_to_pending_review",
      "add_reply_to_pull_request_comment",
      "resolve_review_thread",
      "unresolve_review_thread",
      "actions_list",
      "actions_get",
      "get_job_logs",
      "actions_run_trigger",
      "enable_pr_auto_merge",
      "disable_pr_auto_merge",
      "update_pull_request_branch",
      "request_copilot_review",
      "merge_pull_request",
      "search_code",
      "search_issues",
      "search_pull_requests",
      // 后来补齐的
      "get_me",
      "create_branch",
      "create_or_update_file",
      "delete_file",
      "push_files",
      "sub_issue_write",
      "update_issue_comment",
      "list_releases",
      "get_latest_release",
      "get_release_by_tag",
      "list_tags",
      "get_tag",
      "list_repository_collaborators",
      "get_teams",
      "get_team_members",
      "list_issue_types",
      "list_issue_fields",
    ]) {
      expect(names).toContain(name);
    }
    for (const tool of list.result.tools) expect(tool.inputSchema.type).toBe("object");

    expect((await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, "wrong")).status).toBe(401);
    expect((await fetch(mcpUrl)).status).toBe(405);
    const unknown = (await (
      await rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" })
    ).json()) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
  });

  it("参数不对：工具返回错误说明，不请求 GitHub", async () => {
    const result = await call("create_pull_request", { owner: "octo", repo: "app", title: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("参数不对");
    expect(api.requests).toHaveLength(0);
  });
});

describe("只能操作本会话的仓库，以用户本人的账号", () => {
  it("读文件：带用户的令牌请求 GitHub，文本解码后给出来", async () => {
    api.route("GET /repos/octo/app/contents/src/a.ts", () => ({
      json: {
        type: "file",
        path: "src/a.ts",
        size: 5,
        sha: "abc",
        encoding: "base64",
        content: Buffer.from("hello").toString("base64"),
      },
    }));
    const result = await call("get_file_contents", {
      owner: "octo",
      repo: "app",
      path: "src/a.ts",
      ref: "main",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ path: "src/a.ts", sha: "abc", content: "hello" });
    expect(api.requests[0]?.auth).toBe(`Bearer ${USER_TOKEN}`);
    expect(api.requests[0]?.query.get("ref")).toBe("main");
  });

  it("别的仓库一律拒绝；只读挂载的仓库不能写。被拒的都没有发到 GitHub", async () => {
    const other = await call("create_pull_request", {
      owner: "other",
      repo: "secret",
      title: "x",
      head: "a",
      base: "main",
    });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("没有挂载");

    const readOnly = await call("add_issue_comment", {
      owner: "someone",
      repo: "lib",
      issue_number: 1,
      body: "hi",
    });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toContain("只读");

    const autoMerge = await call("enable_pr_auto_merge", {
      owner: "other",
      repo: "secret",
      pullNumber: 1,
    });
    expect(autoMerge.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it("文件路径里的 .. 不能跳到别的仓库", async () => {
    const result = await call("get_file_contents", {
      owner: "octo",
      repo: "app",
      path: "../../other/secret/contents/token.txt",
    });
    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it("GitHub 返回的错误原样告诉 Agent", async () => {
    api.route("POST /repos/octo/app/pulls", () => ({
      status: 422,
      json: { message: "Validation Failed" },
    }));
    const result = await call("create_pull_request", {
      owner: "octo",
      repo: "app",
      title: "x",
      head: "a",
      base: "main",
    });
    expect(result).toEqual({ isError: true, text: "GitHub 返回 422：Validation Failed" });
  });

  it("会话结束后（令牌作废）不能再用", async () => {
    sessions.register({
      sessionId: "s2",
      sessionToken: "sess_gone",
      repos: [{ fullName: "octo/app", access: "push" }],
    });
    sessions.remove("s2");
    expect((await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, "sess_gone")).status).toBe(
      401,
    );
  });
});

describe("署名：写到 GitHub 的正文都带一次", () => {
  it("评论、PR、回复、review 的正文末尾加署名；已经带了的不重复", async () => {
    api.route("POST /repos/octo/app/issues/3/comments", () => ({ status: 201, json: { id: 1 } }));
    api.route("POST /repos/octo/app/pulls", () => ({ status: 201, json: { number: 7 } }));
    api.route("PATCH /repos/octo/app/pulls/7", () => ({ json: { number: 7 } }));
    api.route("POST /repos/octo/app/pulls/7/comments/55/replies", () => ({
      status: 201,
      json: { id: 2 },
    }));
    api.route("POST /repos/octo/app/pulls/7/reviews", () => ({ json: { id: 9 } }));

    await call("add_issue_comment", {
      owner: "octo",
      repo: "app",
      issue_number: 3,
      body: `看过了。${footer}`,
    });
    await call("create_pull_request", {
      owner: "octo",
      repo: "app",
      title: "修复",
      head: "seekcloud/x",
      base: "main",
      body: "改了登录",
    });
    await call("update_pull_request", {
      owner: "octo",
      repo: "app",
      pullNumber: 7,
      body: `改了登录${footer}`,
    });
    await call("update_pull_request", {
      owner: "octo",
      repo: "app",
      pullNumber: 7,
      title: "只改标题",
    });
    await call("add_reply_to_pull_request_comment", {
      owner: "octo",
      repo: "app",
      pullNumber: 7,
      commentId: 55,
      body: "已修改",
    });
    await call("pull_request_review_write", {
      method: "create",
      owner: "octo",
      repo: "app",
      pullNumber: 7,
      event: "COMMENT",
      body: "整体可以",
      comments: [{ path: "a.ts", line: 3, body: "这里少了判空" }],
    });

    const bodies = api.requests.map((r) => r.body as Record<string, unknown> | undefined);
    expect(bodies[0]?.body).toBe(`看过了。${footer}`);
    expect(bodies[1]?.body).toBe(`改了登录${footer}`);
    expect(bodies[2]?.body).toBe(`改了登录${footer}`);
    // 只改标题：不碰正文。
    expect(bodies[3]).toEqual({ title: "只改标题" });
    expect(bodies[4]?.body).toBe(`已修改${footer}`);
    expect(bodies[5]).toMatchObject({
      event: "COMMENT",
      body: `整体可以${footer}`,
      comments: [{ path: "a.ts", line: 3, body: `这里少了判空${footer}` }],
    });
  });
});

describe("只有 GraphQL 能做的：用写死的查询，先确认仓库", () => {
  it("解决评审线程：线程属于本会话的仓库才解决；别的仓库的线程只查不改", async () => {
    const mutations: string[] = [];
    api.onGraphql((query, variables) => {
      if (query.includes("node(id: $id)")) {
        const repo = variables.id === "T_mine" ? "octo/app" : "other/secret";
        return {
          data: { node: { pullRequest: { number: 7, repository: { nameWithOwner: repo } } } },
        };
      }
      mutations.push(query);
      return { data: { resolveReviewThread: { thread: { id: variables.id, isResolved: true } } } };
    });

    const mine = await call("resolve_review_thread", { threadId: "T_mine" });
    expect(mine.isError).toBe(false);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toContain("resolveReviewThread");

    const theirs = await call("resolve_review_thread", { threadId: "T_theirs" });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toContain("没有挂载");
    expect(mutations).toHaveLength(1);
  });

  it("自动合并：用 REST 取到本会话仓库里的 PR，再用它的 ID 打开", async () => {
    api.route("GET /repos/octo/app/pulls/7", () => ({
      json: { number: 7, node_id: "PR_node7", head: { sha: "h1" } },
    }));
    let variables: Record<string, unknown> = {};
    api.onGraphql((query, vars) => {
      variables = vars;
      expect(query).toContain("enablePullRequestAutoMerge");
      return { data: { enablePullRequestAutoMerge: { pullRequest: { number: 7 } } } };
    });
    const result = await call("enable_pr_auto_merge", {
      owner: "octo",
      repo: "app",
      pullNumber: 7,
      mergeMethod: "SQUASH",
    });
    expect(result.isError).toBe(false);
    expect(variables).toEqual({ id: "PR_node7", method: "SQUASH" });
  });

  it("未提交的 review：建、加行内评论（带署名）、提交", async () => {
    api.route("POST /repos/octo/app/pulls/8/reviews", () => ({
      json: { id: 31, state: "PENDING" },
    }));
    api.route("GET /user", () => ({ json: { login: "octo" } }));
    api.route("GET /repos/octo/app/pulls/8/reviews", () => ({
      json: [
        { id: 30, node_id: "R_other", state: "PENDING", user: { login: "someone-else" } },
        { id: 31, node_id: "R_mine", state: "PENDING", user: { login: "octo" } },
      ],
    }));
    api.route("POST /repos/octo/app/pulls/8/reviews/31/events", () => ({
      json: { id: 31, state: "COMMENTED" },
    }));
    let added: Record<string, unknown> = {};
    api.onGraphql((_query, vars) => {
      added = vars;
      return { data: { addPullRequestReviewThread: { thread: { id: "T1" } } } };
    });

    await call("pull_request_review_write", {
      method: "create",
      owner: "octo",
      repo: "app",
      pullNumber: 8,
    });
    expect(api.requests[0]?.body).toEqual({});
    const comment = await call("add_comment_to_pending_review", {
      owner: "octo",
      repo: "app",
      pullNumber: 8,
      path: "a.ts",
      line: 2,
      body: "建议改名",
    });
    expect(comment.isError).toBe(false);
    expect(added).toMatchObject({
      review: "R_mine",
      path: "a.ts",
      line: 2,
      body: `建议改名${footer}`,
    });
    const submitted = await call("pull_request_review_write", {
      method: "submit_pending",
      owner: "octo",
      repo: "app",
      pullNumber: 8,
      event: "COMMENT",
    });
    expect(submitted.isError).toBe(false);
    expect(api.requests.at(-1)?.body).toEqual({ event: "COMMENT", body: `---\n${FOOTER_LINE}` });
  });
});

describe("搜索只在本会话的仓库里", () => {
  it("自动加上本会话的仓库；查询自带 repo:/org: 或指定没挂载的仓库都拒绝", async () => {
    api.route("GET /search/issues", () => ({ json: { total_count: 0, items: [] } }));
    const ok = await call("search_pull_requests", { query: "login bug" });
    expect(ok.isError).toBe(false);
    expect(api.requests[0]?.query.get("q")).toBe("login bug repo:octo/app repo:someone/lib is:pr");

    const narrowed = await call("search_issues", { query: "crash", owner: "octo", repo: "app" });
    expect(narrowed.isError).toBe(false);
    expect(api.requests[1]?.query.get("q")).toBe("crash repo:octo/app is:issue");

    for (const query of [
      "token repo:other/secret",
      "x org:acme",
      "x -repo:octo/app",
      "x (repo:other/secret)",
      "x REPO: other/secret",
    ]) {
      const refused = await call("search_code", { query });
      expect(refused.isError).toBe(true);
    }
    const unmounted = await call("search_code", { query: "x", owner: "other", repo: "secret" });
    expect(unmounted.isError).toBe(true);
    expect(api.requests).toHaveLength(2);
  });
});

describe("CI", () => {
  it("作业日志：跟着跳转取日志，只给最后几行；按运行读失败作业的日志", async () => {
    const log = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    api.route("GET /repos/octo/app/actions/jobs/77/logs", () => ({
      location: `${apiBase}/blob/77`,
    }));
    api.route("GET /blob/77", () => ({ text: log }));
    api.route("GET /repos/octo/app/actions/runs/5/jobs", () => ({
      json: {
        jobs: [
          { id: 77, name: "test", conclusion: "failure" },
          { id: 78, name: "lint", conclusion: "success" },
        ],
      },
    }));

    const one = await call("get_job_logs", {
      owner: "octo",
      repo: "app",
      job_id: 77,
      tail_lines: 3,
    });
    expect(one.text).toBe("（前 7 行已省略）\nline 8\nline 9\nline 10");

    const failed = await call("get_job_logs", {
      owner: "octo",
      repo: "app",
      run_id: 5,
      failed_only: true,
      tail_lines: 1,
    });
    expect(failed.text).toBe("### test（77）\n（前 9 行已省略）\nline 10");
  });

  it("重跑失败的作业；不能手动触发工作流这类不在白名单的操作", async () => {
    api.route("POST /repos/octo/app/actions/runs/5/rerun-failed-jobs", () => ({
      status: 201,
      json: {},
    }));
    const rerun = await call("actions_run_trigger", {
      method: "rerun_failed_jobs",
      owner: "octo",
      repo: "app",
      run_id: 5,
    });
    expect(rerun.isError).toBe(false);
    expect(api.requests[0]?.path).toBe("/repos/octo/app/actions/runs/5/rerun-failed-jobs");
  });
});

describe("返回给 Agent 的内容精简过", () => {
  it("去掉链接、头像，用户只留登录名，仓库只留全名", async () => {
    api.route("GET /repos/octo/app/pulls/9", () => ({
      json: {
        number: 9,
        title: "修复",
        url: "https://api.github.com/x",
        html_url: "https://github.com/octo/app/pull/9",
        comments_url: "https://api.github.com/y",
        node_id: "PR_9",
        user: { login: "octo", id: 1, avatar_url: "https://a" },
        head: {
          ref: "seekcloud/x",
          sha: "h",
          repo: {
            full_name: "octo/app",
            owner: { login: "octo", avatar_url: "a" },
            private: false,
          },
        },
        _links: { self: {} },
      },
    }));
    const result = await call("pull_request_read", {
      method: "get",
      owner: "octo",
      repo: "app",
      pullNumber: 9,
    });
    expect(JSON.parse(result.text)).toEqual({
      number: 9,
      title: "修复",
      html_url: "https://github.com/octo/app/pull/9",
      user: "octo",
      head: { ref: "seekcloud/x", sha: "h", repo: "octo/app" },
    });
  });
});

const TRAILER = "Generated-by: SeekCloud Agent (AI)";

describe("工具建的提交", () => {
  it("说明末尾带 AI 生成的尾注：接在已有的尾注后面，不重复", () => {
    expect(withTrailer("修 bug")).toBe(`修 bug\n\n${TRAILER}`);
    expect(withTrailer("修 bug\n\n详细说明。\n")).toBe(`修 bug\n\n详细说明。\n\n${TRAILER}`);
    expect(withTrailer("修 bug\n\nSigned-off-by: A <a@x>")).toBe(
      `修 bug\n\nSigned-off-by: A <a@x>\n${TRAILER}`,
    );
    expect(withTrailer(`修 bug\n\n${TRAILER}`)).toBe(`修 bug\n\n${TRAILER}`);
    // 只有一段、像尾注的标题不算尾注段
    expect(withTrailer("fix: 修 bug")).toBe(`fix: 修 bug\n\n${TRAILER}`);
  });

  it("push_files：建树、建提交（带尾注）、快进分支，不强推", async () => {
    api.route("GET /repos/octo/app/git/ref/heads/feature/x", () => ({
      json: { ref: "refs/heads/feature/x", object: { sha: "c1" } },
    }));
    api.route("GET /repos/octo/app/git/commits/c1", () => ({
      json: { sha: "c1", tree: { sha: "t1" } },
    }));
    api.route("POST /repos/octo/app/git/trees", () => ({ status: 201, json: { sha: "t2" } }));
    api.route("POST /repos/octo/app/git/commits", () => ({ status: 201, json: { sha: "c2" } }));
    api.route("PATCH /repos/octo/app/git/refs/heads/feature/x", () => ({
      json: { ref: "refs/heads/feature/x", object: { sha: "c2" } },
    }));
    const result = await call("push_files", {
      owner: "octo",
      repo: "app",
      branch: "feature/x",
      message: "加两个文件",
      files: [
        { path: "a.txt", content: "a" },
        { path: "dir/b.txt", content: "b" },
      ],
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ ref: "refs/heads/feature/x", object: { sha: "c2" } });
    const [, , tree, commit, update] = api.requests;
    expect(tree?.body).toEqual({
      base_tree: "t1",
      tree: [
        { path: "a.txt", mode: "100644", type: "blob", content: "a" },
        { path: "dir/b.txt", mode: "100644", type: "blob", content: "b" },
      ],
    });
    expect(commit?.body).toEqual({
      message: `加两个文件\n\n${TRAILER}`,
      tree: "t2",
      parents: ["c1"],
    });
    expect(update?.body).toEqual({ sha: "c2", force: false });
  });

  it("push_files：分支不存在就从默认分支建出来", async () => {
    let created = false;
    api.route("GET /repos/octo/app/git/ref/heads/new", () => ({
      status: 404,
      json: { message: "Not Found" },
    }));
    api.route("GET /repos/octo/app", () => ({ json: { default_branch: "main" } }));
    api.route("GET /repos/octo/app/git/ref/heads/main", () => ({
      json: { object: { sha: "m1" } },
    }));
    api.route("POST /repos/octo/app/git/refs", () => {
      created = true;
      return { status: 201, json: { ref: "refs/heads/new", object: { sha: "m1" } } };
    });
    api.route("GET /repos/octo/app/git/commits/m1", () => ({
      json: { sha: "m1", tree: { sha: "t1" } },
    }));
    api.route("PATCH /repos/octo/app/git/refs/heads/new", () => ({
      json: { object: { sha: "c2" } },
    }));
    const result = await call("push_files", {
      owner: "octo",
      repo: "app",
      branch: "new",
      message: "m",
      files: [{ path: "a.txt", content: "a" }],
    });
    expect(result.isError).toBe(false);
    expect(created).toBe(true);
    expect(api.requests.find((r) => r.path === "/repos/octo/app/git/refs")?.body).toEqual({
      ref: "refs/heads/new",
      sha: "m1",
    });
  });

  it("delete_file：树里把这个路径设成空", async () => {
    api.route("GET /repos/octo/app/git/ref/heads/main", () => ({
      json: { object: { sha: "m1" } },
    }));
    api.route("GET /repos/octo/app/git/commits/m1", () => ({
      json: { sha: "m1", tree: { sha: "t1" } },
    }));
    api.route("PATCH /repos/octo/app/git/refs/heads/main", () => ({
      json: { object: { sha: "c2" } },
    }));
    const result = await call("delete_file", {
      owner: "octo",
      repo: "app",
      path: "/src/old.ts",
      message: "删掉旧文件",
      branch: "main",
    });
    expect(result.isError).toBe(false);
    expect(api.requests[2]?.body).toEqual({
      base_tree: "t1",
      tree: [{ path: "src/old.ts", mode: "100644", type: "blob", sha: null }],
    });
    expect(api.requests[3]?.body).toMatchObject({ message: `删掉旧文件\n\n${TRAILER}` });
  });

  it("create_or_update_file：新文件直接写；已有的要给当前的 sha；符号链接不覆盖", async () => {
    api.route("GET /repos/octo/app/contents/docs/new.md", () => ({
      status: 404,
      json: { message: "Not Found" },
    }));
    api.route("PUT /repos/octo/app/contents/docs/new.md", () => ({
      status: 201,
      json: { content: { path: "docs/new.md", sha: "b2" }, commit: { sha: "c2" } },
    }));
    const created = await call("create_or_update_file", {
      owner: "octo",
      repo: "app",
      path: "docs/new.md",
      content: "你好",
      message: "加文档",
      branch: "seekcloud/x",
    });
    expect(created.isError).toBe(false);
    expect(api.requests[0]?.query.get("ref")).toBe("seekcloud/x");
    expect(api.requests[1]?.body).toEqual({
      message: `加文档\n\n${TRAILER}`,
      content: Buffer.from("你好").toString("base64"),
      branch: "seekcloud/x",
    });

    api.route("GET /repos/octo/app/contents/a.ts", () => ({ json: { type: "file", sha: "s1" } }));
    api.route("GET /repos/octo/app/contents", () => ({
      json: [
        { name: "a.ts", type: "file" },
        { name: "link", type: "symlink" },
      ],
    }));
    const args = {
      owner: "octo",
      repo: "app",
      path: "a.ts",
      content: "x",
      message: "m",
      branch: "main",
    };
    api.requests.length = 0;
    const blind = await call("create_or_update_file", args);
    expect(blind.isError).toBe(true);
    expect(blind.text).toContain("sha");
    const stale = await call("create_or_update_file", { ...args, sha: "old" });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("s1");
    expect(api.requests.some((r) => r.method === "PUT")).toBe(false);

    api.route("GET /repos/octo/app/contents/link", () => ({ json: { type: "file", sha: "s2" } }));
    const link = await call("create_or_update_file", { ...args, path: "link", sha: "s2" });
    expect(link.isError).toBe(true);
    expect(link.text).toContain("符号链接");
  });

  it("写操作照样受范围限制：别的仓库、只读仓库、标签都不放行，不发到 GitHub", async () => {
    const attempts = [
      call("create_branch", { owner: "other", repo: "secret", branch: "x" }),
      call("create_branch", { owner: "someone", repo: "lib", branch: "x" }),
      call("push_files", {
        owner: "someone",
        repo: "lib",
        branch: "main",
        message: "m",
        files: [{ path: "a", content: "a" }],
      }),
      call("delete_file", {
        owner: "other",
        repo: "secret",
        path: "a",
        message: "m",
        branch: "main",
      }),
      call("sub_issue_write", {
        method: "add",
        owner: "someone",
        repo: "lib",
        issue_number: 1,
        sub_issue_id: 2,
      }),
    ];
    for (const result of await Promise.all(attempts)) expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);

    // 直接用 REST 建引用：分支放行，标签不放行（代理的同一条规则）
    const session = {
      sessionId: "s1",
      sessionToken: "t",
      repos: [{ fullName: "octo/app", access: "push" as const }],
      githubToken: USER_TOKEN,
    };
    const client = new GitHubClient(session, apiBase);
    await expect(
      client.rest("POST", "/repos/octo/app/git/refs", { body: { ref: "refs/tags/v1", sha: "c1" } }),
    ).rejects.toThrow("标签");
    expect(api.requests).toHaveLength(0);
  });

  it("get_tag：附注标签再取标签对象，轻量标签给引用", async () => {
    api.route("GET /repos/octo/app/git/ref/tags/v1", () => ({
      json: { ref: "refs/tags/v1", object: { type: "tag", sha: "g1" } },
    }));
    api.route("GET /repos/octo/app/git/tags/g1", () => ({ json: { tag: "v1", message: "发布" } }));
    api.route("GET /repos/octo/app/git/ref/tags/light", () => ({
      json: { ref: "refs/tags/light", object: { type: "commit", sha: "c1" } },
    }));
    expect(
      JSON.parse((await call("get_tag", { owner: "octo", repo: "app", tag: "v1" })).text),
    ).toEqual({
      tag: "v1",
      message: "发布",
    });
    expect(
      JSON.parse((await call("get_tag", { owner: "octo", repo: "app", tag: "light" })).text),
    ).toEqual({ ref: "refs/tags/light", object: { type: "commit", sha: "c1" } });
  });
});

describe("子 issue、评论、团队、issue 类型和字段", () => {
  it("子 issue：加、移除、调整顺序；调整顺序只能给 after_id 或 before_id 中的一个", async () => {
    api.route("POST /repos/octo/app/issues/1/sub_issues", () => ({ status: 201, json: { id: 2 } }));
    api.route("DELETE /repos/octo/app/issues/1/sub_issue", () => ({ json: { id: 2 } }));
    api.route("PATCH /repos/octo/app/issues/1/sub_issues/priority", () => ({ json: { id: 2 } }));
    const base = { owner: "octo", repo: "app", issue_number: 1, sub_issue_id: 2 };
    expect(
      (await call("sub_issue_write", { ...base, method: "add", replace_parent: true })).isError,
    ).toBe(false);
    expect((await call("sub_issue_write", { ...base, method: "remove" })).isError).toBe(false);
    expect(
      (await call("sub_issue_write", { ...base, method: "reprioritize", after_id: 3 })).isError,
    ).toBe(false);
    expect(api.requests.map((r) => r.body)).toEqual([
      { sub_issue_id: 2, replace_parent: true },
      { sub_issue_id: 2 },
      { sub_issue_id: 2, after_id: 3 },
    ]);
    const both = await call("sub_issue_write", {
      ...base,
      method: "reprioritize",
      after_id: 3,
      before_id: 4,
    });
    expect(both.isError).toBe(true);
    expect(api.requests).toHaveLength(3);
  });

  it("改评论带署名", async () => {
    api.route("PATCH /repos/octo/app/issues/comments/7", () => ({ json: { id: 7 } }));
    await call("update_issue_comment", {
      owner: "octo",
      repo: "app",
      comment_id: 7,
      body: "改一下",
    });
    expect(api.requests[0]?.body).toEqual({ body: `改一下${footer}` });
  });

  it("release 可以只要部分字段", async () => {
    api.route("GET /repos/octo/app/releases", () => ({
      json: [{ id: 1, tag_name: "v1", body: "很长的说明", draft: false }],
    }));
    const result = await call("list_releases", {
      owner: "octo",
      repo: "app",
      fields: ["tag_name"],
    });
    expect(JSON.parse(result.text)).toEqual([{ tag_name: "v1" }]);
  });

  it("团队只列挂载了仓库的组织；别的组织的团队成员不查", async () => {
    api.route("GET /user", () => ({ json: { login: "me" } }));
    api.onGraphql((query, variables) => {
      if (query.includes("teams(")) {
        expect(variables).toEqual({ login: "me" });
        return {
          data: {
            user: {
              organizations: {
                nodes: [
                  {
                    login: "Octo",
                    teams: { nodes: [{ name: "核心", slug: "core", description: "" }] },
                  },
                  { login: "elsewhere", teams: { nodes: [{ name: "x", slug: "x" }] } },
                ],
              },
            },
          },
        };
      }
      return {
        data: { organization: { team: { members: { nodes: [{ login: "a" }, { login: "b" }] } } } },
      };
    });
    expect(JSON.parse((await call("get_teams", {})).text)).toEqual([
      { org: "Octo", teams: [{ name: "核心", slug: "core", description: "" }] },
    ]);
    expect(
      JSON.parse((await call("get_team_members", { org: "octo", team_slug: "core" })).text),
    ).toEqual(["a", "b"]);
    api.requests.length = 0;
    expect((await call("get_team_members", { org: "elsewhere", team_slug: "x" })).isError).toBe(
      true,
    );
    expect(api.requests).toHaveLength(0);
  });

  it("issue 类型借挂载的仓库查；issue 字段声明预览功能；没挂载仓库的所有者不查", async () => {
    api.route("GET /repos/octo/app/issue-types", () => ({ json: [{ id: 1, name: "Bug" }] }));
    expect(JSON.parse((await call("list_issue_types", { owner: "octo" })).text)).toEqual([
      { id: 1, name: "Bug" },
    ]);

    api.onGraphql((query, variables) => {
      expect(query).toContain("organization(login: $login)");
      expect(variables).toEqual({ login: "octo" });
      return {
        data: {
          organization: {
            issueFields: {
              nodes: [
                {
                  __typename: "IssueFieldSingleSelect",
                  id: "F1",
                  fullDatabaseId: "11",
                  name: "优先级",
                  description: "",
                  dataType: "SINGLE_SELECT",
                  visibility: "ALL",
                  options: [{ id: "O1", name: "高", color: "RED" }],
                },
                { __typename: "SomethingNew" },
              ],
            },
          },
        },
      };
    });
    const fields = await call("list_issue_fields", { owner: "octo" });
    expect(JSON.parse(fields.text)).toEqual([
      {
        id: "F1",
        full_database_id: 11,
        name: "优先级",
        data_type: "SINGLE_SELECT",
        visibility: "ALL",
        options: [{ id: "O1", name: "高", color: "RED" }],
      },
    ]);
    expect(api.requests.at(-1)?.features).toBe("issue_fields,repo_issue_fields");

    api.requests.length = 0;
    expect((await call("list_issue_types", { owner: "elsewhere" })).isError).toBe(true);
    expect((await call("list_issue_fields", { owner: "octo", repo: "secret" })).isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });
});
