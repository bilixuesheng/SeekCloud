import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppDeps } from "../app";
import { currentUser } from "../auth/login-sessions";
import { apiError, errorResponse, githubNotConnected, notLoggedIn } from "../errors";
import { finishGitHubLink, startGitHubLink } from "../github/link";
import { disconnectGitHub, githubConnection, withGitHubToken } from "../github/tokens";
import type { Sessions } from "../sessions/sessions";
import { jsonBody as json, newRouter } from "./router";

/** 关联 GitHub：跳到 GitHub 授权，授权后跳回来。 */
export function githubAuthRoutes(deps: AppDeps) {
  return newRouter()
    .get("/start", (c) => c.redirect(startGitHubLink(deps, c), 302))
    .get("/callback", async (c) => c.redirect(await finishGitHubLink(deps, c), 302));
}

const Repo = z.object({
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  canPush: z.boolean(),
});

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  summary: "GitHub 关联状态",
  responses: {
    200: {
      description: "关联状态",
      ...json(
        z.object({ connected: z.boolean(), login: z.string().optional(), installUrl: z.string() }),
      ),
    },
    401: errorResponse("没有登录"),
  },
});

const unlinkRoute = createRoute({
  method: "post",
  path: "/unlink",
  summary: "解除关联 GitHub，删掉 GitHub 令牌",
  responses: {
    204: { description: "已解除" },
    401: errorResponse("没有登录"),
    404: errorResponse("没有关联 GitHub"),
  },
});

const reposRoute = createRoute({
  method: "get",
  path: "/repos",
  summary: "可选的仓库：装了 App 的仓库；带 q 时再加上搜到的公开仓库",
  request: { query: z.object({ q: z.string().optional() }) },
  responses: {
    200: { description: "仓库列表", ...json(z.object({ repos: z.array(Repo) })) },
    401: errorResponse("没有登录"),
    409: errorResponse("还没有关联 GitHub"),
  },
});

const branchesRoute = createRoute({
  method: "get",
  path: "/repos/{owner}/{repo}/branches",
  summary: "仓库的分支",
  request: { params: z.object({ owner: z.string(), repo: z.string() }) },
  responses: {
    200: { description: "分支列表", ...json(z.object({ branches: z.array(z.string()) })) },
    401: errorResponse("没有登录"),
    409: errorResponse("还没有关联 GitHub"),
  },
});

/** 用登录用户的 GitHub 令牌调 GitHub。没登录返回 401，没关联（或令牌失效）返回 409。 */
async function withGitHub<T>(
  deps: AppDeps,
  c: Context,
  call: (token: string) => Promise<T>,
): Promise<T | 401 | 409> {
  const user = await currentUser(deps, c);
  if (!user) return 401;
  const result = await withGitHubToken(deps, user.id, call);
  return result === "not_connected" ? 409 : result;
}

/** GitHub pull_request webhook 里用得到的部分。 */
const PullRequestPayload = z.object({
  pull_request: z.object({
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean().optional(),
    draft: z.boolean().optional(),
    updated_at: z.iso.datetime({ offset: true }),
    head: z.object({
      ref: z.string(),
      repo: z.object({ full_name: z.string() }).nullable().optional(),
    }),
  }),
});

/** 关联状态、解除关联、仓库、分支，以及接收 GitHub webhook 的入口。 */
export function githubRoutes(deps: AppDeps, sessions: Sessions) {
  return newRouter()
    .openapi(statusRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      const connection = await githubConnection(deps, user.id);
      return c.json(
        connection
          ? { connected: true, login: connection.login, installUrl: deps.github.installUrl }
          : { connected: false, installUrl: deps.github.installUrl },
        200,
      );
    })
    .openapi(unlinkRoute, async (c) => {
      const user = await currentUser(deps, c);
      if (!user) return c.json(notLoggedIn, 401);
      if (!(await disconnectGitHub(deps, user.id))) {
        return c.json(apiError("not_linked", "尚未关联 GitHub"), 404);
      }
      return c.body(null, 204);
    })
    .openapi(reposRoute, async (c) => {
      const q = c.req.valid("query").q?.trim();
      const repos = await withGitHub(deps, c, async (token) => {
        const installed = await deps.github.listInstalledRepos(token);
        if (!q) return installed;
        // 搜到的公开仓库如果装了 App，用装了 App 的那条（可以推送）。
        const byName = new Map(installed.map((r) => [r.fullName, r]));
        const matches = installed.filter((r) => r.fullName.toLowerCase().includes(q.toLowerCase()));
        const found = (await deps.github.searchPublicRepos(token, q)).map(
          (r) => byName.get(r.fullName) ?? r,
        );
        const seen = new Set<string>();
        return [...matches, ...found].filter((r) => !seen.has(r.fullName) && seen.add(r.fullName));
      });
      if (repos === 401) return c.json(notLoggedIn, 401);
      if (repos === 409) return c.json(githubNotConnected, 409);
      return c.json({ repos }, 200);
    })
    .openapi(branchesRoute, async (c) => {
      const { owner, repo } = c.req.valid("param");
      const branches = await withGitHub(deps, c, (token) =>
        deps.github.listBranches(token, `${owner}/${repo}`),
      );
      if (branches === 401) return c.json(notLoggedIn, 401);
      if (branches === 409) return c.json(githubNotConnected, 409);
      return c.json({ branches }, 200);
    })
    .post("/webhook", async (c) => {
      const body = await c.req.text();
      if (!deps.github.verifyWebhook(body, c.req.header("x-hub-signature-256"))) {
        return c.json(apiError("invalid_signature", "签名无效"), 401);
      }
      // 仓库列表每次都现查，不用处理安装变化。仓库权限被收回之类的处理在后面的工单里加。
      if (c.req.header("x-github-event") === "pull_request") {
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return c.json(apiError("invalid_payload", "webhook 内容格式错误"), 400);
        }
        const parsed = PullRequestPayload.safeParse(payload);
        // 会话分支都推在会话自己的仓库里。分支所在的仓库已经删了（比如删掉的 fork）时，
        // 不知道它在哪，不能拿基础仓库去对，免得同名分支对错会话。
        const headRepo = parsed.success ? parsed.data.pull_request.head.repo : null;
        if (parsed.success && headRepo) {
          const pr = parsed.data.pull_request;
          await sessions.updatePullRequest({
            repo: headRepo.full_name,
            branch: pr.head.ref,
            number: pr.number,
            state: pr.merged
              ? "merged"
              : pr.state === "closed"
                ? "closed"
                : pr.draft
                  ? "draft"
                  : "open",
            updatedAt: new Date(pr.updated_at),
          });
        }
      }
      return c.body(null, 204);
    });
}
