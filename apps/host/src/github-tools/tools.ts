import { z } from "zod";
import { type GitHubClient, ToolError } from "./client";
import { withFooter } from "./footer";

/**
 * 给 Agent 的 GitHub 工具。名字和参数照 GitHub 官方 MCP 服务，Agent 换过来不用重新学。
 * 所有操作只能针对本会话挂载的仓库，以用户本人的 GitHub 账号发出；
 * 写到 GitHub 上的正文都带一次"由 SeekCloud 生成（AI）"的署名。
 */
export interface Tool {
  name: string;
  description: string;
  schema: z.ZodObject;
  run(client: GitHubClient, args: never): Promise<unknown>;
}

const Name = z.string().regex(/^[A-Za-z0-9_.-]+$/, { error: "只能包含字母、数字、-、_、." });
const repoParams = {
  owner: Name.describe("仓库所有者"),
  repo: Name.describe("仓库名"),
};
const pageParams = {
  page: z.number().int().min(1).optional().describe("页码，从 1 开始"),
  perPage: z.number().int().min(1).max(100).optional().describe("每页条数，最多 100"),
};
const Number_ = (what: string) => z.number().int().positive().describe(what);

const repoPath = (a: { owner: string; repo: string }, ...rest: Array<string | number>) =>
  `/repos/${a.owner}/${a.repo}${rest.map((part) => `/${part}`).join("")}`;

const pages = (a: { page?: number; perPage?: number }) => ({ page: a.page, per_page: a.perPage });

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (client: GitHubClient, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): Tool {
  return { name, description, schema: z.object(shape).strict(), run: run as Tool["run"] };
}

/** 文件内容：文本直接给出来；目录给条目列表。 */
async function fileContents(
  client: GitHubClient,
  a: { owner: string; repo: string; path?: string; ref?: string },
) {
  const path = (a.path ?? "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const data = await client.rest<unknown>("GET", repoPath(a, "contents", ...(path ? [path] : [])), {
    query: { ref: a.ref },
  });
  if (Array.isArray(data)) {
    return data.map((e: { name: string; path: string; type: string; size: number }) => ({
      name: e.name,
      path: e.path,
      type: e.type,
      size: e.size,
    }));
  }
  const file = data as {
    type: string;
    path: string;
    size: number;
    sha: string;
    encoding?: string;
    content?: string;
  };
  if (file.type !== "file" || file.encoding !== "base64" || file.content === undefined) {
    return { path: file.path, type: file.type, size: file.size, sha: file.sha };
  }
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.includes(0)) {
    return { path: file.path, size: file.size, sha: file.sha, note: "二进制文件，不显示内容" };
  }
  return { path: file.path, sha: file.sha, content: bytes.toString("utf8") };
}

/** PR 的 head 提交。 */
async function headSha(
  client: GitHubClient,
  a: { owner: string; repo: string; pullNumber: number },
) {
  const pr = await client.rest<{ head: { sha: string } }>(
    "GET",
    repoPath(a, "pulls", a.pullNumber),
  );
  return pr.head.sha;
}

/** 当前用户在这个 PR 上还没提交的 review。 */
async function myPendingReview(
  client: GitHubClient,
  a: { owner: string; repo: string; pullNumber: number },
) {
  const me = await client.rest<{ login: string }>("GET", "/user");
  const reviews = await client.rest<
    Array<{ id: number; node_id: string; state: string; user: { login: string } | null }>
  >("GET", repoPath(a, "pulls", a.pullNumber, "reviews"), { query: { per_page: 100 } });
  const pending = reviews.find((r) => r.state === "PENDING" && r.user?.login === me.login);
  if (!pending) {
    throw new ToolError(
      "这个 PR 上没有你未提交的 review。先用 pull_request_review_write 的 create（不带 event）建一个。",
    );
  }
  return pending;
}

const REVIEW_THREADS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine diffSide
          comments(first: 30) { nodes { databaseId author { login } body createdAt } }
        }
      }
    }
  }
}`;

const THREAD_REPO = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } }
  }
}`;

/** 评审线程属于哪个仓库：先确认是本会话可推送的仓库，再解决或重开。 */
async function setThreadResolved(client: GitHubClient, threadId: string, resolved: boolean) {
  const found = await client.graphql<{
    node: { pullRequest?: { number: number; repository: { nameWithOwner: string } } } | null;
  }>(THREAD_REPO, { id: threadId });
  const repo = found.node?.pullRequest?.repository.nameWithOwner;
  if (!repo) throw new ToolError(`找不到评审线程 ${threadId}`);
  client.requireRepo(repo, true);
  const mutation = resolved
    ? "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }"
    : "mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }";
  return client.graphql(mutation, { id: threadId });
}

/** 搜索只能在本会话的仓库里：不接受自带的 repo:/org:/user: 条件，由服务补上。 */
function scopedQuery(client: GitHubClient, query: string, a: { owner?: string; repo?: string }) {
  // 前面不管是空格、减号还是括号，只要出现这几个条件就拒绝，免得用 (repo:别的仓库) 这类写法绕过去。
  if (/(^|[^a-z0-9_])(repo|org|user|owner)\s*:/i.test(query)) {
    throw new ToolError(
      "搜索只限当前会话的仓库，查询里不能带 repo:、org:、user: 条件。要指定仓库，请用 owner 和 repo 参数。",
    );
  }
  // GitHub 的搜索支持 OR 和括号。"密码 OR" 后面接上我们补的 repo: 条件，就成了"密码，或者本会话仓库里的"，
  // 能搜到令牌够得着的别的仓库。所以不接受 OR 和括号（空格本来就是"并且"，够用了）。
  if (/(^|[\s(])OR([\s)]|$)|[()]/.test(query)) {
    throw new ToolError(
      "搜索条件里不能用 OR 和括号。多个条件用空格分开（表示同时满足），或者分几次搜。",
    );
  }
  const repos =
    a.owner && a.repo
      ? [client.requireRepo(`${a.owner}/${a.repo}`).fullName]
      : client.repos.map((r) => r.fullName);
  if (repos.length === 0) throw new ToolError("当前会话没有挂载仓库。");
  return `${query} ${repos.map((r) => `repo:${r}`).join(" ")}`;
}

const searchParams = {
  query: z.string().min(1).describe("搜索条件（GitHub 搜索语法），不能包含 repo:、org:、user:"),
  owner: Name.optional().describe("只搜这个仓库：所有者"),
  repo: Name.optional().describe("只搜这个仓库：仓库名"),
  ...pageParams,
};

/** 路径、分支、标签里可以有 /：逐段编码，/ 本身留着（代理不放行编码过的斜杠）。 */
const segments = (value: string) =>
  value.split("/").filter(Boolean).map(encodeURIComponent).join("/");

const COMMIT_TRAILER = "Generated-by: SeekCloud (AI)";

/**
 * 工具建的提交和沙箱里的一样，说明末尾带 AI 生成的尾注（见 sandbox/git-hooks）：
 * 最后一段已经是尾注（比如 Signed-off-by）就接在后面，否则空一行；已有的同一行不重复。
 */
export function withTrailer(message: string): string {
  const text = message
    .split("\n")
    .filter((line) => line.trim() !== COMMIT_TRAILER)
    .join("\n")
    .trim();
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? "";
  const trailers = paragraphs.length > 1 && last.split("\n").every((l) => /^[\w-]+: \S/.test(l));
  return `${text}${trailers ? "\n" : "\n\n"}${COMMIT_TRAILER}`;
}

/** 按"署名"开关决定加不加署名。关着时原样交出去：不加，Agent 自己写了的也不删。 */
const signed = (client: GitHubClient, body: string | undefined) =>
  client.aiLabels.signature ? withFooter(body) : body;

/** 按"提交尾注"开关决定加不加尾注。 */
const trailed = (client: GitHubClient, message: string) =>
  client.aiLabels.commitTrailer ? withTrailer(message) : message;

/** 组织级的工具只能查挂载了仓库的所有者，返回其中一个仓库。 */
function ownerRepo(client: GitHubClient, owner: string, repo?: string) {
  if (repo) return client.requireRepo(`${owner}/${repo}`);
  const found = client.repos.find(
    (r) => r.fullName.split("/")[0]?.toLowerCase() === owner.toLowerCase(),
  );
  if (!found) {
    throw new ToolError(`${owner} 名下没有挂载到当前会话的仓库，不能查它的信息。`);
  }
  return found;
}

const branchRef = (a: { owner: string; repo: string }, branch: string) =>
  `${repoPath(a, "git", "ref", "heads")}/${segments(branch)}`;

type TreeEntry = { path: string; mode: "100644"; type: "blob"; content?: string; sha?: null };

/**
 * 在分支上提交一次改动（照官方：Git 数据接口建树、建提交，再快进分支，不强推）。
 * 分支是 404 时 missing 决定怎么办：官方 push_files 从默认分支建出来。
 */
async function commitToBranch(
  client: GitHubClient,
  a: { owner: string; repo: string },
  branch: string,
  entries: TreeEntry[],
  message: string,
  missing?: () => Promise<{ object: { sha: string } }>,
) {
  let head: { object: { sha: string } };
  try {
    head = await client.rest("GET", branchRef(a, branch));
  } catch (error) {
    if (error instanceof ToolError && error.status === 409) {
      throw new ToolError("仓库还是空的，先用 create_or_update_file 建第一个文件。");
    }
    if (!(error instanceof ToolError && error.status === 404 && missing)) throw error;
    head = await missing();
  }
  const base = await client.rest<{ sha: string; tree: { sha: string } }>(
    "GET",
    repoPath(a, "git", "commits", head.object.sha),
  );
  const tree = await client.rest<{ sha: string }>("POST", repoPath(a, "git", "trees"), {
    body: { base_tree: base.tree.sha, tree: entries },
  });
  const commit = await client.rest<{ sha: string }>("POST", repoPath(a, "git", "commits"), {
    body: { message: trailed(client, message), tree: tree.sha, parents: [base.sha] },
  });
  const ref = await client.rest(
    "PATCH",
    `${repoPath(a, "git", "refs", "heads")}/${segments(branch)}`,
    { body: { sha: commit.sha, force: false } },
  );
  return { ref, commit };
}

/** 从 from（默认是仓库的默认分支）建出新分支。 */
async function createBranch(
  client: GitHubClient,
  a: { owner: string; repo: string },
  branch: string,
  from?: string,
) {
  const source =
    from ?? (await client.rest<{ default_branch: string }>("GET", repoPath(a))).default_branch;
  const head = await client.rest<{ object: { sha: string } }>("GET", branchRef(a, source));
  return client.rest<{ object: { sha: string } }>("POST", repoPath(a, "git", "refs"), {
    body: { ref: `refs/heads/${branch}`, sha: head.object.sha },
  });
}

/** 文件现在的样子：不存在是 null；目录、符号链接照官方不让直接覆盖。 */
async function existingFile(
  client: GitHubClient,
  a: { owner: string; repo: string; path: string; branch: string },
) {
  let file: unknown;
  try {
    file = await client.rest("GET", repoPath(a, "contents", segments(a.path)), {
      query: { ref: a.branch },
    });
  } catch (error) {
    if (error instanceof ToolError && error.status === 404) return null;
    throw error;
  }
  if (Array.isArray(file)) throw new ToolError(`${a.path} 是目录，这个工具只能写文件。`);
  const { sha, type } = file as { sha: string; type: string };
  // 内容接口会顺着符号链接给出目标文件，要看所在目录的列表才知道它本身是不是链接。
  const parts = a.path.split("/").filter(Boolean);
  const name = parts.pop();
  const listing = await client.rest<Array<{ name: string; type: string }>>(
    "GET",
    repoPath(a, "contents", ...(parts.length ? [segments(parts.join("/"))] : [])),
    { query: { ref: a.branch } },
  );
  const symlink =
    type === "symlink" || listing.some((e) => e.name === name && e.type === "symlink");
  return { sha, symlink };
}

const ISSUE_FIELD = "id fullDatabaseId name description dataType visibility";
const ISSUE_FIELDS = `issueFields(first: 100) { nodes {
  __typename
  ... on IssueFieldText { ${ISSUE_FIELD} }
  ... on IssueFieldNumber { ${ISSUE_FIELD} }
  ... on IssueFieldDate { ${ISSUE_FIELD} }
  ... on IssueFieldSingleSelect { ${ISSUE_FIELD} options { id name description color priority } }
} }`;

interface IssueFieldNode {
  __typename: string;
  id: string;
  fullDatabaseId?: string | null;
  name: string;
  description?: string | null;
  dataType: string;
  visibility: string;
  options?: unknown[];
}

const TEAMS = `query($login: String!) {
  user(login: $login) {
    organizations(first: 100) {
      nodes { login teams(first: 100, userLogins: [$login]) { nodes { name slug description } } }
    }
  }
}`;

const TEAM_MEMBERS = `query($org: String!, $slug: String!) {
  organization(login: $org) { team(slug: $slug) { members(first: 100) { nodes { login } } } }
}`;

/** 作业日志只给最后几行，免得撑满上下文。 */
const tail = (log: string, lines: number) => {
  const all = log.split("\n");
  return all.length <= lines
    ? log
    : `（前 ${all.length - lines} 行已省略）\n${all.slice(-lines).join("\n")}`;
};

const ReviewComment = z.object({
  path: z.string().describe("文件路径"),
  body: z.string().describe("评论内容"),
  line: z.number().int().positive().optional().describe("评论的行（新版本的行号）"),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  start_line: z.number().int().positive().optional().describe("多行评论的起始行"),
  start_side: z.enum(["LEFT", "RIGHT"]).optional(),
});

export const TOOLS: Tool[] = [
  tool(
    "get_file_contents",
    "读取仓库里的文件或目录。文件给出文本内容，目录给出条目列表。",
    {
      ...repoParams,
      path: z.string().optional().describe("路径，留空是根目录"),
      ref: z.string().optional().describe("分支、标签或提交，默认是默认分支"),
    },
    (c, a) => fileContents(c, a),
  ),
  tool("list_branches", "列出仓库的分支。", { ...repoParams, ...pageParams }, (c, a) =>
    c.rest("GET", repoPath(a, "branches"), { query: pages(a) }),
  ),
  tool(
    "list_commits",
    "列出提交。",
    {
      ...repoParams,
      sha: z.string().optional().describe("从哪个分支或提交开始"),
      author: z.string().optional(),
      ...pageParams,
    },
    (c, a) =>
      c.rest("GET", repoPath(a, "commits"), {
        query: { sha: a.sha, author: a.author, ...pages(a) },
      }),
  ),
  tool(
    "get_commit",
    "查看一个提交：信息、改了哪些文件和差异。",
    { ...repoParams, sha: z.string().min(1).describe("提交的 SHA、分支或标签") },
    (c, a) => c.rest("GET", repoPath(a, "commits", encodeURIComponent(a.sha))),
  ),
  tool(
    "list_issues",
    "列出 issue（不含 PR）。",
    {
      ...repoParams,
      state: z.enum(["open", "closed", "all"]).optional(),
      labels: z.array(z.string()).optional(),
      ...pageParams,
    },
    async (c, a) => {
      const issues = await c.rest<Array<{ pull_request?: unknown }>>("GET", repoPath(a, "issues"), {
        query: { state: a.state, labels: a.labels?.join(","), ...pages(a) },
      });
      return issues.filter((issue) => !issue.pull_request);
    },
  ),
  tool(
    "issue_read",
    "读取 issue：get 详情、get_comments 评论、get_labels 标签。",
    {
      method: z.enum(["get", "get_comments", "get_labels"]),
      ...repoParams,
      issue_number: Number_("issue 编号"),
      ...pageParams,
    },
    (c, a) => {
      const base = repoPath(a, "issues", a.issue_number);
      if (a.method === "get") return c.rest("GET", base);
      return c.rest("GET", `${base}/${a.method === "get_comments" ? "comments" : "labels"}`, {
        query: pages(a),
      });
    },
  ),
  tool(
    "issue_write",
    "创建（create）或修改（update）issue。",
    {
      method: z.enum(["create", "update"]),
      ...repoParams,
      issue_number: Number_("要修改的 issue 编号（update 时必填）").optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      state: z.enum(["open", "closed"]).optional(),
      state_reason: z.enum(["completed", "not_planned", "reopened"]).optional(),
    },
    (c, a) => {
      const fields = {
        title: a.title,
        labels: a.labels,
        assignees: a.assignees,
        state: a.state,
        state_reason: a.state_reason,
        ...(a.body !== undefined || a.method === "create" ? { body: signed(c, a.body) } : {}),
      };
      if (a.method === "create") {
        if (!a.title) throw new ToolError("创建 issue 需要 title。");
        return c.rest("POST", repoPath(a, "issues"), { body: fields });
      }
      if (!a.issue_number) throw new ToolError("修改 issue 需要 issue_number。");
      return c.rest("PATCH", repoPath(a, "issues", a.issue_number), { body: fields });
    },
  ),
  tool(
    "add_issue_comment",
    "在 issue 或 PR 下发表评论。",
    { ...repoParams, issue_number: Number_("issue 或 PR 的编号"), body: z.string().min(1) },
    (c, a) =>
      c.rest("POST", repoPath(a, "issues", a.issue_number, "comments"), {
        body: { body: signed(c, a.body) },
      }),
  ),
  tool(
    "list_pull_requests",
    "列出 PR。",
    {
      ...repoParams,
      state: z.enum(["open", "closed", "all"]).optional(),
      head: z.string().optional().describe("按来源分支过滤，格式 owner:branch"),
      base: z.string().optional(),
      ...pageParams,
    },
    (c, a) =>
      c.rest("GET", repoPath(a, "pulls"), {
        query: { state: a.state, head: a.head, base: a.base, ...pages(a) },
      }),
  ),
  tool(
    "pull_request_read",
    "读取 PR：get 详情、get_diff 差异、get_files 改动的文件、get_commits 提交、get_status 提交状态、get_check_runs 检查、get_reviews review、get_review_comments 评审线程（含线程 ID，可用来解决线程）、get_comments 普通评论。",
    {
      method: z.enum([
        "get",
        "get_diff",
        "get_files",
        "get_commits",
        "get_status",
        "get_check_runs",
        "get_reviews",
        "get_review_comments",
        "get_comments",
      ]),
      ...repoParams,
      pullNumber: Number_("PR 编号"),
      ...pageParams,
    },
    async (c, a) => {
      const base = repoPath(a, "pulls", a.pullNumber);
      switch (a.method) {
        case "get":
          return c.rest("GET", base);
        case "get_diff":
          return c.rest("GET", base, { accept: "application/vnd.github.diff" });
        case "get_files":
        case "get_commits":
        case "get_reviews":
          return c.rest("GET", `${base}/${a.method.slice(4)}`, { query: pages(a) });
        case "get_comments":
          return c.rest("GET", repoPath(a, "issues", a.pullNumber, "comments"), {
            query: pages(a),
          });
        case "get_status":
          return c.rest("GET", repoPath(a, "commits", await headSha(c, a), "status"));
        case "get_check_runs":
          return c.rest("GET", repoPath(a, "commits", await headSha(c, a), "check-runs"), {
            query: pages(a),
          });
        case "get_review_comments": {
          // 评审线程（和线程 ID）只有 GraphQL 有。仓库先按 REST 的规则确认挂载在本会话上。
          c.requireRepo(`${a.owner}/${a.repo}`);
          const data = await c.graphql<{
            repository: { pullRequest: { reviewThreads: unknown } | null } | null;
          }>(REVIEW_THREADS, { owner: a.owner, name: a.repo, number: a.pullNumber, after: null });
          const threads = data.repository?.pullRequest?.reviewThreads;
          if (!threads) throw new ToolError(`找不到 PR #${a.pullNumber}`);
          return threads;
        }
      }
    },
  ),
  tool(
    "create_pull_request",
    "创建 PR。",
    {
      ...repoParams,
      title: z.string().min(1),
      head: z.string().min(1).describe("来源分支"),
      base: z.string().min(1).describe("目标分支"),
      body: z.string().optional(),
      draft: z.boolean().optional(),
      maintainer_can_modify: z.boolean().optional(),
    },
    (c, a) =>
      c.rest("POST", repoPath(a, "pulls"), {
        body: {
          title: a.title,
          head: a.head,
          base: a.base,
          body: signed(c, a.body),
          draft: a.draft,
          maintainer_can_modify: a.maintainer_can_modify,
        },
      }),
  ),
  tool(
    "update_pull_request",
    "修改 PR 的标题、正文、目标分支或状态（关闭、重开）。",
    {
      ...repoParams,
      pullNumber: Number_("PR 编号"),
      title: z.string().optional(),
      body: z.string().optional(),
      base: z.string().optional(),
      state: z.enum(["open", "closed"]).optional(),
      maintainer_can_modify: z.boolean().optional(),
    },
    (c, a) =>
      c.rest("PATCH", repoPath(a, "pulls", a.pullNumber), {
        body: {
          title: a.title,
          base: a.base,
          state: a.state,
          maintainer_can_modify: a.maintainer_can_modify,
          ...(a.body === undefined ? {} : { body: signed(c, a.body) }),
        },
      }),
  ),
  tool(
    "pull_request_review_write",
    "写 review：create 创建（带 event 直接提交；不带 event 是未提交的 review，之后可以加行内评论再提交），submit_pending 提交未提交的 review，delete_pending 删除未提交的 review。",
    {
      method: z.enum(["create", "submit_pending", "delete_pending"]),
      ...repoParams,
      pullNumber: Number_("PR 编号"),
      body: z.string().optional(),
      event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
      commitID: z.string().optional().describe("review 针对的提交，默认是最新提交"),
      comments: z.array(ReviewComment).optional().describe("创建时一起提交的行内评论"),
    },
    async (c, a) => {
      if (a.method === "create") {
        return c.rest("POST", repoPath(a, "pulls", a.pullNumber, "reviews"), {
          body: {
            commit_id: a.commitID,
            event: a.event,
            // 没有正文的未提交 review 先不加署名，提交时再加。
            ...(a.body !== undefined || a.event ? { body: signed(c, a.body) } : {}),
            comments: a.comments?.map((comment) => ({
              ...comment,
              body: signed(c, comment.body),
            })),
          },
        });
      }
      const pending = await myPendingReview(c, a);
      const path = repoPath(a, "pulls", a.pullNumber, "reviews", pending.id);
      if (a.method === "delete_pending") return c.rest("DELETE", path);
      if (!a.event)
        throw new ToolError("提交 review 需要 event：APPROVE、REQUEST_CHANGES 或 COMMENT。");
      return c.rest("POST", `${path}/events`, {
        body: { event: a.event, body: signed(c, a.body) },
      });
    },
  ),
  tool(
    "add_comment_to_pending_review",
    "给你未提交的 review 加一条行内评论。",
    {
      ...repoParams,
      pullNumber: Number_("PR 编号"),
      path: z.string().min(1),
      body: z.string().min(1),
      line: z.number().int().positive().optional(),
      side: z.enum(["LEFT", "RIGHT"]).optional(),
      startLine: z.number().int().positive().optional(),
      startSide: z.enum(["LEFT", "RIGHT"]).optional(),
      subjectType: z.enum(["LINE", "FILE"]).optional(),
    },
    async (c, a) => {
      // 只有 GraphQL 能往未提交的 review 里加评论。review 先按 REST 的规则在本会话的仓库里找到。
      c.requireRepo(`${a.owner}/${a.repo}`, true);
      const pending = await myPendingReview(c, a);
      return c.graphql(
        `mutation($review: ID!, $path: String!, $body: String!, $line: Int, $side: DiffSide, $startLine: Int, $startSide: DiffSide, $subjectType: PullRequestReviewThreadSubjectType) {
          addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, body: $body, line: $line, side: $side, startLine: $startLine, startSide: $startSide, subjectType: $subjectType }) { thread { id } }
        }`,
        {
          review: pending.node_id,
          path: a.path,
          body: signed(c, a.body),
          line: a.line ?? null,
          side: a.side ?? null,
          startLine: a.startLine ?? null,
          startSide: a.startSide ?? null,
          subjectType: a.subjectType ?? null,
        },
      );
    },
  ),
  tool(
    "add_reply_to_pull_request_comment",
    "回复 PR 上的一条行内评论。",
    {
      ...repoParams,
      pullNumber: Number_("PR 编号"),
      commentId: Number_("要回复的评论 ID"),
      body: z.string().min(1),
    },
    (c, a) =>
      c.rest("POST", repoPath(a, "pulls", a.pullNumber, "comments", a.commentId, "replies"), {
        body: { body: signed(c, a.body) },
      }),
  ),
  tool(
    "resolve_review_thread",
    "把评审线程标为已解决。线程 ID 从 pull_request_read 的 get_review_comments 里拿。",
    { threadId: z.string().min(1) },
    (c, a) => setThreadResolved(c, a.threadId, true),
  ),
  tool(
    "unresolve_review_thread",
    "重新打开已解决的评审线程。",
    { threadId: z.string().min(1) },
    (c, a) => setThreadResolved(c, a.threadId, false),
  ),
  tool(
    "merge_pull_request",
    "合并 PR。",
    {
      ...repoParams,
      pullNumber: Number_("PR 编号"),
      merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
      commit_title: z.string().optional(),
      commit_message: z.string().optional(),
      expectedHeadSha: z.string().optional().describe("PR 最新提交必须是这个才合并"),
    },
    (c, a) =>
      c.rest("PUT", repoPath(a, "pulls", a.pullNumber, "merge"), {
        body: {
          merge_method: a.merge_method,
          commit_title: a.commit_title,
          commit_message: a.commit_message,
          sha: a.expectedHeadSha,
        },
      }),
  ),
  tool(
    "update_pull_request_branch",
    "把目标分支的最新改动合进 PR 的分支。",
    { ...repoParams, pullNumber: Number_("PR 编号"), expectedHeadSha: z.string().optional() },
    (c, a) =>
      c.rest("PUT", repoPath(a, "pulls", a.pullNumber, "update-branch"), {
        body: { expected_head_sha: a.expectedHeadSha },
      }),
  ),
  tool(
    "enable_pr_auto_merge",
    "打开 PR 的自动合并：检查都通过、满足合并条件后自动合并。",
    {
      ...repoParams,
      pullNumber: Number_("PR 编号"),
      mergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]).optional(),
    },
    async (c, a) => {
      // 只有 GraphQL 能开自动合并。PR 先按 REST 的规则在本会话可推送的仓库里取到。
      c.requireRepo(`${a.owner}/${a.repo}`, true);
      const pr = await c.rest<{ node_id: string }>("GET", repoPath(a, "pulls", a.pullNumber));
      return c.graphql(
        "mutation($id: ID!, $method: PullRequestMergeMethod) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { number autoMergeRequest { enabledAt mergeMethod } } } }",
        { id: pr.node_id, method: a.mergeMethod ?? null },
      );
    },
  ),
  tool(
    "disable_pr_auto_merge",
    "关闭 PR 的自动合并。",
    { ...repoParams, pullNumber: Number_("PR 编号") },
    async (c, a) => {
      c.requireRepo(`${a.owner}/${a.repo}`, true);
      const pr = await c.rest<{ node_id: string }>("GET", repoPath(a, "pulls", a.pullNumber));
      return c.graphql(
        "mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } } }",
        { id: pr.node_id },
      );
    },
  ),
  tool(
    "request_copilot_review",
    "请 GitHub Copilot 审查这个 PR。",
    { ...repoParams, pullNumber: Number_("PR 编号") },
    (c, a) =>
      c.rest("POST", repoPath(a, "pulls", a.pullNumber, "requested_reviewers"), {
        body: { reviewers: ["copilot-pull-request-reviewer[bot]"] },
      }),
  ),
  tool(
    "actions_list",
    "列出 CI：list_workflows 工作流、list_workflow_runs 运行（resource_id 填工作流 ID 或文件名可以只看一个工作流）、list_workflow_jobs 某次运行的作业（resource_id 填运行 ID）、list_workflow_run_artifacts 某次运行的产物。",
    {
      method: z.enum([
        "list_workflows",
        "list_workflow_runs",
        "list_workflow_jobs",
        "list_workflow_run_artifacts",
      ]),
      ...repoParams,
      resource_id: z.string().optional(),
      branch: z.string().optional().describe("只看这个分支的运行"),
      status: z.string().optional().describe("只看这个状态的运行，比如 completed、failure"),
      ...pageParams,
    },
    (c, a) => {
      const id = a.resource_id ? encodeURIComponent(a.resource_id) : undefined;
      const need = () => {
        if (!id) throw new ToolError(`${a.method} 需要 resource_id。`);
        return id;
      };
      switch (a.method) {
        case "list_workflows":
          return c.rest("GET", repoPath(a, "actions", "workflows"), { query: pages(a) });
        case "list_workflow_runs":
          return c.rest(
            "GET",
            id ? repoPath(a, "actions", "workflows", id, "runs") : repoPath(a, "actions", "runs"),
            { query: { branch: a.branch, status: a.status, ...pages(a) } },
          );
        case "list_workflow_jobs":
          return c.rest("GET", repoPath(a, "actions", "runs", need(), "jobs"), { query: pages(a) });
        case "list_workflow_run_artifacts":
          return c.rest("GET", repoPath(a, "actions", "runs", need(), "artifacts"), {
            query: pages(a),
          });
      }
    },
  ),
  tool(
    "actions_get",
    "查看 CI：get_workflow 工作流、get_workflow_run 一次运行、get_workflow_job 一个作业。",
    {
      method: z.enum(["get_workflow", "get_workflow_run", "get_workflow_job"]),
      ...repoParams,
      resource_id: z.string().min(1),
    },
    (c, a) => {
      const id = encodeURIComponent(a.resource_id);
      const kind = {
        get_workflow: "workflows",
        get_workflow_run: "runs",
        get_workflow_job: "jobs",
      }[a.method];
      return c.rest("GET", repoPath(a, "actions", kind, id));
    },
  ),
  tool(
    "get_job_logs",
    "读 CI 作业的日志（只给最后几行）。给 job_id 读一个作业；给 run_id 加 failed_only 读这次运行所有失败作业的日志。",
    {
      ...repoParams,
      job_id: z.number().int().positive().optional(),
      run_id: z.number().int().positive().optional(),
      failed_only: z.boolean().optional(),
      tail_lines: z.number().int().min(1).max(2000).optional().describe("最后多少行，默认 300"),
    },
    async (c, a) => {
      const lines = a.tail_lines ?? 300;
      const log = (jobId: number) =>
        c.rest<string>("GET", repoPath(a, "actions", "jobs", jobId, "logs"), { raw: true });
      if (a.job_id) return tail(await log(a.job_id), lines);
      if (!a.run_id) throw new ToolError("需要 job_id，或者 run_id 加 failed_only。");
      const { jobs } = await c.rest<{
        jobs: Array<{ id: number; name: string; conclusion: string | null }>;
      }>("GET", repoPath(a, "actions", "runs", a.run_id, "jobs"), { query: { per_page: 100 } });
      const chosen = a.failed_only ? jobs.filter((job) => job.conclusion === "failure") : jobs;
      const out: string[] = [];
      for (const job of chosen)
        out.push(`### ${job.name}（${job.id}）\n${tail(await log(job.id), lines)}`);
      return out.join("\n\n") || "这次运行没有符合条件的作业。";
    },
  ),
  tool(
    "actions_run_trigger",
    "重跑或取消 CI：rerun_workflow_run 重跑整次运行，rerun_failed_jobs 只重跑失败的作业，cancel_workflow_run 取消。",
    {
      method: z.enum(["rerun_workflow_run", "rerun_failed_jobs", "cancel_workflow_run"]),
      ...repoParams,
      run_id: z.number().int().positive(),
    },
    (c, a) => {
      const action = {
        rerun_workflow_run: "rerun",
        rerun_failed_jobs: "rerun-failed-jobs",
        cancel_workflow_run: "cancel",
      }[a.method];
      return c.rest("POST", repoPath(a, "actions", "runs", a.run_id, action));
    },
  ),
  tool("search_code", "在当前会话的仓库里搜索代码。", searchParams, (c, a) =>
    c.search("code", scopedQuery(c, a.query, a), a.page, a.perPage),
  ),
  tool("search_issues", "在当前会话的仓库里搜索 issue。", searchParams, (c, a) =>
    c.search("issues", `${scopedQuery(c, a.query, a)} is:issue`, a.page, a.perPage),
  ),
  tool("search_pull_requests", "在当前会话的仓库里搜索 PR。", searchParams, (c, a) =>
    c.search("issues", `${scopedQuery(c, a.query, a)} is:pr`, a.page, a.perPage),
  ),

  // 以下是后来补齐的工具。
  tool(
    "get_me",
    "查看当前 GitHub 用户（也就是用户本人）的资料。要拼别的工具的参数、又缺信息时用。",
    {},
    (c) => c.rest("GET", "/user"),
  ),
  tool(
    "update_issue_comment",
    "修改 issue 或 PR 下的一条普通评论（不能改 PR 的行内评论）。",
    {
      ...repoParams,
      comment_id: Number_("评论 ID"),
      body: z.string().min(1).describe("新的评论内容"),
    },
    (c, a) =>
      c.rest("PATCH", repoPath(a, "issues", "comments", a.comment_id), {
        body: { body: signed(c, a.body) },
      }),
  ),
  tool(
    "list_releases",
    "列出仓库的 release。",
    {
      ...repoParams,
      fields: z
        .array(
          z.enum([
            "id",
            "tag_name",
            "name",
            "body",
            "html_url",
            "published_at",
            "prerelease",
            "draft",
            "author",
          ]),
        )
        .optional()
        .describe("每个 release 只要这些字段；不写就全给。不要 body 能省很多篇幅"),
      ...pageParams,
    },
    async (c, a) => {
      const releases = await c.rest<Array<Record<string, unknown>>>(
        "GET",
        repoPath(a, "releases"),
        { query: pages(a) },
      );
      const { fields } = a;
      if (!fields) return releases;
      return releases.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    },
  ),
  tool("get_latest_release", "查看仓库最新的 release。", repoParams, (c, a) =>
    c.rest("GET", repoPath(a, "releases", "latest")),
  ),
  tool(
    "get_release_by_tag",
    "按标签名查看 release。",
    { ...repoParams, tag: z.string().min(1).describe("标签名，比如 v1.0.0") },
    (c, a) => c.rest("GET", `${repoPath(a, "releases", "tags")}/${segments(a.tag)}`),
  ),
  tool("list_tags", "列出仓库的标签。", { ...repoParams, ...pageParams }, (c, a) =>
    c.rest("GET", repoPath(a, "tags"), { query: pages(a) }),
  ),
  tool(
    "list_repository_collaborators",
    "列出仓库的协作者。",
    {
      ...repoParams,
      affiliation: z
        .enum(["outside", "direct", "all"])
        .optional()
        .describe("outside 外部协作者，direct 直接有权限的，all 全部（默认）"),
      ...pageParams,
    },
    (c, a) =>
      c.rest("GET", repoPath(a, "collaborators"), {
        query: { affiliation: a.affiliation, ...pages(a) },
      }),
  ),
  tool(
    "get_tag",
    "查看一个标签：轻量标签给出它指向的提交，附注标签给出标签对象。",
    { ...repoParams, tag: z.string().min(1).describe("标签名") },
    async (c, a) => {
      const ref = await c.rest<{ object: { type: string; sha: string } }>(
        "GET",
        `${repoPath(a, "git", "ref", "tags")}/${segments(a.tag)}`,
      );
      if (ref.object.type !== "tag") return ref;
      return c.rest("GET", repoPath(a, "git", "tags", ref.object.sha));
    },
  ),
  tool(
    "create_branch",
    "新建分支。",
    {
      ...repoParams,
      branch: z.string().min(1).describe("新分支的名字"),
      from_branch: z.string().min(1).optional().describe("从哪个分支建，默认是仓库的默认分支"),
    },
    (c, a) => {
      c.requireRepo(`${a.owner}/${a.repo}`, true);
      return createBranch(c, a, a.branch, a.from_branch);
    },
  ),
  tool(
    "create_or_update_file",
    "在 GitHub 上新建或修改一个文件，直接提交到分支（不是改本地文件）。改已有的文件要给 sha：用 get_file_contents 读同一路径、ref 设成这个分支，拿到的 sha 就是。",
    {
      ...repoParams,
      path: z.string().min(1).describe("文件路径"),
      content: z.string().describe("文件写好后的内容，原样给出，不要 base64"),
      message: z.string().min(1).describe("提交说明"),
      branch: z.string().min(1).describe("提交到哪个分支"),
      sha: z.string().optional().describe("被替换的文件的 blob SHA；文件已经存在时必填"),
      allow_symlink_write: z
        .boolean()
        .optional()
        .describe("要改符号链接本身时设成 true，content 写新的目标路径"),
    },
    async (c, a) => {
      c.requireRepo(`${a.owner}/${a.repo}`, true);
      const current = await existingFile(c, a);
      if (current && !a.sha) {
        throw new ToolError(
          `${a.path} 已经存在。先用 get_file_contents 读它（ref 设成 ${a.branch}），再带上它的 sha 重试，免得盖掉别人的改动。`,
        );
      }
      if (current && a.sha !== current.sha) {
        throw new ToolError(
          `sha 过期了：文件现在的 sha 是 ${current.sha}。先用 get_file_contents 重新读一遍，按最新内容改好再提交。`,
        );
      }
      if (current?.symlink && !a.allow_symlink_write) {
        throw new ToolError(
          `${a.path} 是符号链接。要改的是它指向的文件就写那个路径；真要改链接本身，设 allow_symlink_write。`,
        );
      }
      return c.rest("PUT", repoPath(a, "contents", segments(a.path)), {
        body: {
          message: trailed(c, a.message),
          content: Buffer.from(a.content).toString("base64"),
          branch: a.branch,
          sha: a.sha,
        },
      });
    },
  ),
  tool(
    "delete_file",
    "从分支上删掉一个文件，提交一次。",
    {
      ...repoParams,
      path: z.string().min(1).describe("要删的文件"),
      message: z.string().min(1).describe("提交说明"),
      branch: z.string().min(1).describe("在哪个分支上删"),
    },
    async (c, a) => {
      c.requireRepo(`${a.owner}/${a.repo}`, true);
      const path = a.path.split("/").filter(Boolean).join("/");
      const { commit } = await commitToBranch(
        c,
        a,
        a.branch,
        [{ path, mode: "100644", type: "blob", sha: null }],
        a.message,
      );
      return { commit, content: null };
    },
  ),
  tool(
    "push_files",
    "一次提交多个文件到分支；分支不存在就从默认分支建出来。",
    {
      ...repoParams,
      branch: z.string().min(1).describe("推到哪个分支"),
      files: z
        .array(z.object({ path: z.string().min(1), content: z.string() }).strict())
        .min(1)
        .describe("要写的文件，每个给出路径和完整内容"),
      message: z.string().min(1).describe("提交说明"),
    },
    async (c, a) => {
      c.requireRepo(`${a.owner}/${a.repo}`, true);
      const entries = a.files.map(
        (f): TreeEntry => ({ path: f.path, mode: "100644", type: "blob", content: f.content }),
      );
      const { ref } = await commitToBranch(c, a, a.branch, entries, a.message, () =>
        createBranch(c, a, a.branch),
      );
      return ref;
    },
  ),
  tool(
    "sub_issue_write",
    "子 issue：add 加到父 issue 下（要换父 issue 时带 replace_parent）、remove 移除、reprioritize 调整顺序（after_id 和 before_id 给一个）。sub_issue_id 是 issue 的 ID，不是编号。",
    {
      method: z.enum(["add", "remove", "reprioritize"]),
      ...repoParams,
      issue_number: Number_("父 issue 的编号"),
      sub_issue_id: Number_("子 issue 的 ID（不是编号）"),
      replace_parent: z
        .boolean()
        .optional()
        .describe("add 时：子 issue 已经有父 issue，就换成这个"),
      after_id: Number_("排在这个子 issue 后面").optional(),
      before_id: Number_("排在这个子 issue 前面").optional(),
    },
    (c, a) => {
      const base = repoPath(a, "issues", a.issue_number);
      if (a.method === "add") {
        return c.rest("POST", `${base}/sub_issues`, {
          body: { sub_issue_id: a.sub_issue_id, replace_parent: a.replace_parent },
        });
      }
      if (a.method === "remove") {
        return c.rest("DELETE", `${base}/sub_issue`, { body: { sub_issue_id: a.sub_issue_id } });
      }
      if ((a.after_id === undefined) === (a.before_id === undefined)) {
        throw new ToolError("reprioritize 要给 after_id 或 before_id，只给一个。");
      }
      return c.rest("PATCH", `${base}/sub_issues/priority`, {
        body: { sub_issue_id: a.sub_issue_id, after_id: a.after_id, before_id: a.before_id },
      });
    },
  ),
  tool(
    "get_teams",
    "查看某个用户（默认是自己）所在的团队，只列挂载了仓库的组织里的。",
    { user: Name.optional().describe("用户名，默认是当前用户") },
    async (c, a) => {
      const login = a.user ?? (await c.rest<{ login: string }>("GET", "/user")).login;
      const owners = new Set(c.repos.map((r) => r.fullName.split("/")[0]?.toLowerCase()));
      const data = await c.graphql<{
        user: {
          organizations: {
            nodes: Array<{ login: string; teams: { nodes: unknown[] } }>;
          };
        } | null;
      }>(TEAMS, { login });
      return (data.user?.organizations.nodes ?? [])
        .filter((org) => owners.has(org.login.toLowerCase()))
        .map((org) => ({ org: org.login, teams: org.teams.nodes }));
    },
  ),
  tool(
    "get_team_members",
    "列出组织里某个团队的成员（登录名）。组织要有挂载到当前会话的仓库。",
    { org: Name.describe("组织"), team_slug: Name.describe("团队的 slug") },
    async (c, a) => {
      ownerRepo(c, a.org);
      const data = await c.graphql<{
        organization: { team: { members: { nodes: Array<{ login: string }> } } | null } | null;
      }>(TEAM_MEMBERS, { org: a.org, slug: a.team_slug });
      const team = data.organization?.team;
      if (!team) throw new ToolError(`找不到团队 ${a.org}/${a.team_slug}`);
      return team.members.nodes.map((m) => m.login);
    },
  ),
  tool(
    "list_issue_types",
    "列出可用的 issue 类型（类型由组织统一定义）。",
    { owner: Name.describe("仓库所有者或组织"), repo: Name.optional().describe("仓库名") },
    (c, a) => {
      // 不能直接查组织的接口（代理只放行本会话仓库下的地址），借它名下一个挂载的仓库查。
      const repo = ownerRepo(c, a.owner, a.repo);
      return c.rest("GET", `/repos/${repo.fullName}/issue-types`);
    },
  ),
  tool(
    "list_issue_fields",
    "列出 issue 的自定义字段：名字、类型（text、number、date、single_select），单选字段还有可选的值。不给 repo 就查组织的。",
    { owner: Name.describe("仓库所有者或组织"), repo: Name.optional().describe("仓库名") },
    async (c, a) => {
      const repo = ownerRepo(c, a.owner, a.repo);
      const [owner, name] = repo.fullName.split("/");
      const features = ["issue_fields", "repo_issue_fields"];
      const nodes = a.repo
        ? (
            await c.graphql<{ repository: { issueFields: { nodes: IssueFieldNode[] } } | null }>(
              `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${ISSUE_FIELDS} } }`,
              { owner, name },
              features,
            )
          ).repository?.issueFields.nodes
        : (
            await c.graphql<{ organization: { issueFields: { nodes: IssueFieldNode[] } } | null }>(
              `query($login: String!) { organization(login: $login) { ${ISSUE_FIELDS} } }`,
              { login: a.owner },
              features,
            )
          ).organization?.issueFields.nodes;
      return (nodes ?? [])
        .filter((n) => n.id)
        .map((n) => ({
          id: n.id,
          full_database_id: n.fullDatabaseId ? Number(n.fullDatabaseId) : undefined,
          name: n.name,
          description: n.description || undefined,
          data_type: n.dataType,
          visibility: n.visibility,
          options: n.options,
        }));
    },
  ),
];
