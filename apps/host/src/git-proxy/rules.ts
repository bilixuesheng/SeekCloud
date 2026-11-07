// Git 代理的放行规则（ADR 0003）：
// 只能访问本会话挂载的仓库；不能用 GraphQL；不能删分支、推标签、建 release；任何分支都能推送和强推。
// 另外不放行修改或删除仓库本身。

import type { SessionRepo } from "@seekcloud/protocol";
import { isDelete, type RefUpdate } from "./receive-pack";

/** 挂载到会话的仓库：代理只关心名字和能不能推送。 */
export type MountedRepo = Pick<SessionRepo, "fullName" | "access">;

export interface GitHubRequest {
  host: string;
  method: string;
  /** 路径，不含查询参数。 */
  path: string;
  query: URLSearchParams;
}

/**
 * 放不放行。放行时 inspect 表示还要看请求体才能定：
 * push：推送命令里有没有删分支、推标签；create-ref：建的引用是不是标签。
 */
export type Decision =
  | { allow: true; inspect?: "push" | "create-ref" }
  | { allow: false; status: number; message: string };

/** 代理负责的 GitHub 域名。其他域名归出站网络策略管。 */
export const GITHUB_HOSTS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
] as const;

const deny = (status: number, message: string): Decision => ({ allow: false, status, message });
const allow: Decision = { allow: true };

const TAG_REFUSED = "代理不放行创建或推送标签。";

const notMounted = (fullName: string) =>
  deny(
    403,
    `仓库 ${fullName} 没有挂载到当前会话，代理不放行（公开仓库也要先挂载）。需要的话，先用挂载仓库的工具把它加进来。`,
  );

/** 不需要仓库、也不会泄露别的仓库内容的只读接口。 */
const GENERAL_READ_ONLY = [
  /^\/user$/,
  /^\/rate_limit$/,
  /^\/meta$/,
  /^\/zen$/,
  /^\/octocat$/,
  /^\/emojis$/,
  /^\/licenses(\/[^/]+)?$/,
  /^\/gitignore\/templates(\/[^/]+)?$/,
];

const READ_METHODS = new Set(["GET", "HEAD"]);

export function findRepo(repos: MountedRepo[], owner: string, name: string) {
  const fullName = `${owner}/${name.replace(/\.git$/, "")}`.toLowerCase();
  return repos.find((r) => r.fullName.toLowerCase() === fullName);
}

export function checkRequest(repos: MountedRepo[], req: GitHubRequest): Decision {
  const host = req.host.toLowerCase();
  // 代理和 GitHub 对这种路径的理解可能不一样（空段、编码过的斜杠、编码过的仓库名），一律不放行。
  const raw = req.path.split("/").filter(Boolean);
  const repoStart = host === "api.github.com" ? 1 : 0;
  if (
    req.path.includes("//") ||
    /%2f|%5c|\\/i.test(req.path) ||
    raw.slice(repoStart, repoStart + 2).some((s) => s.includes("%"))
  ) {
    return deny(400, `看不懂的地址：${req.path}`);
  }
  let segments: string[];
  try {
    segments = raw.map(decodeURIComponent);
  } catch {
    return deny(400, `地址里的编码不对：${req.path}`);
  }
  // "." 和 ".." 会被客户端或 GitHub 归一化掉，检查的是一个仓库、实际访问的却是另一个，一律不放行。
  if (segments.some((s) => s === "." || s === "..")) {
    return deny(400, `地址里不能有 . 或 .. 这样的路径段：${req.path}`);
  }

  if (host === "api.github.com") return checkRest(repos, req.method.toUpperCase(), segments);

  const [owner, name, ...rest] = segments;
  if (!owner || !name) return deny(403, `代理只放行本会话仓库下的地址：${host}${req.path}`);
  const repo = findRepo(repos, owner, name);
  if (!repo) return notMounted(`${owner}/${name.replace(/\.git$/, "")}`);

  if (host === "github.com") {
    const tail = rest.join("/");
    const service = req.query.get("service");
    if (tail === "info/refs" && service === "git-upload-pack") return allow;
    if (tail === "git-upload-pack" && req.method === "POST") return allow;
    if ((tail === "info/refs" && service === "git-receive-pack") || tail === "git-receive-pack") {
      if (repo.access !== "push") {
        return deny(
          403,
          `仓库 ${repo.fullName} 是只读挂载的，不能推送。要推送，请在 GitHub 上把 SeekCloud App 装到这个仓库。`,
        );
      }
      return tail === "git-receive-pack" ? { allow: true, inspect: "push" } : allow;
    }
  }
  // 网页上的只读地址：源码压缩包、原始文件、release 下载。
  if (READ_METHODS.has(req.method.toUpperCase())) return allow;
  return deny(
    403,
    `代理只放行对 ${repo.fullName} 的只读访问和 git 推拉：${req.method} ${req.path}`,
  );
}

function checkRest(repos: MountedRepo[], method: string, segments: string[]): Decision {
  const path = `/${segments.join("/")}`;
  if (segments[0] === "graphql") {
    return deny(
      403,
      "代理不放行 GraphQL：没法按仓库限制它的访问范围。请改用 REST 接口，比如 gh api repos/<owner>/<repo>/pulls。",
    );
  }
  if (segments[0] !== "repos") {
    if (READ_METHODS.has(method) && GENERAL_READ_ONLY.some((re) => re.test(path))) {
      return allow;
    }
    return deny(403, `这个 GitHub 接口不在本会话仓库的范围内，代理不放行：${method} ${path}`);
  }

  const [, owner, name, ...rest] = segments;
  if (!owner || !name) return deny(403, `看不懂的接口地址：${path}`);
  const repo = findRepo(repos, owner, name);
  if (!repo) return notMounted(`${owner}/${name}`);
  if (!READ_METHODS.has(method) && repo.access !== "push") {
    return deny(403, `仓库 ${repo.fullName} 是只读挂载的，只能读，不能改：${method} ${path}`);
  }

  if (READ_METHODS.has(method)) return allow;
  const [resource = "", ...more] = rest;
  return checkRepoWrite(repo, method, resource, more, path);
}

/**
 * 对本会话仓库的写操作，只放行 Agent 干活要用的（白名单）：PR、issue、评论、文件、分支、提交状态、重跑 CI。
 * 部署密钥、协作者、webhook、分支保护、密钥、仓库设置之类的一律不放行，哪怕用户自己设了有这些权限的令牌。
 */
function checkRepoWrite(
  repo: MountedRepo,
  method: string,
  resource: string,
  more: string[],
  path: string,
): Decision {
  const refused = deny(
    403,
    `代理只放行 Agent 干活要用的写操作，这个不在其中：${method} ${path}（仓库 ${repo.fullName}）`,
  );
  switch (resource) {
    case "pulls":
    case "issues":
    case "labels":
    case "milestones":
    case "contents":
    case "statuses":
    case "check-runs":
    case "merges":
    case "comments":
      return allow;
    case "commits":
      // 给提交加评论：POST /commits/{sha}/comments
      return more[1] === "comments" ? allow : refused;
    case "check-suites":
      return more.at(-1) === "rerequest" ? allow : refused;
    case "actions":
      // 只能重跑和取消，不能删日志、不能手动触发工作流、不能碰密钥和变量。
      return (more[0] === "runs" || more[0] === "jobs") &&
        ["rerun", "rerun-failed-jobs", "cancel"].includes(more.at(-1) ?? "") &&
        method === "POST"
        ? allow
        : refused;
    case "git":
      return checkGitData(method, more, refused);
    case "releases":
      return deny(403, "代理不放行创建或修改 release：它会生成标签。");
    case "":
      return deny(403, `代理不放行修改或删除仓库本身：${method} ${path}`);
    default:
      return refused;
  }
}

/** Git 数据接口：能建对象、建和改分支；不能删引用、不能碰标签。 */
function checkGitData(method: string, more: string[], refused: Decision): Decision {
  const [kind = "", ...rest] = more;
  if (kind === "blobs" || kind === "trees" || kind === "commits") {
    return method === "POST" ? allow : refused;
  }
  if (kind === "tags") return deny(403, TAG_REFUSED);
  if (kind !== "refs") return refused;
  const ref = rest.join("/");
  if (method === "DELETE") {
    return deny(403, `代理不放行删除引用（${ref || "refs"}）：不能删除分支和标签。`);
  }
  if (ref.startsWith("tags/")) return deny(403, TAG_REFUSED);
  if (method === "POST" && !ref) return { allow: true, inspect: "create-ref" };
  if (method === "PATCH" && ref.startsWith("heads/")) return allow;
  return refused;
}

/** 创建引用（POST /repos/.../git/refs）：建分支放行，建标签不放行。 */
export function checkCreateRef(body: string): Decision {
  let ref: unknown;
  try {
    ref = (JSON.parse(body) as { ref?: unknown }).ref;
  } catch {
    return deny(400, "请求体不是 JSON");
  }
  return typeof ref === "string" && ref.startsWith("refs/tags/") ? deny(403, TAG_REFUSED) : allow;
}

/** 一次推送里哪些引用不放行，以及原因。为空就是都放行。 */
export function pushRefusals(updates: RefUpdate[]): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const update of updates) {
    if (update.ref.startsWith("refs/tags/")) reasons.set(update.ref, TAG_REFUSED);
    else if (isDelete(update)) reasons.set(update.ref, "代理不放行删除分支。");
    else if (!update.ref.startsWith("refs/heads/")) {
      reasons.set(update.ref, "代理只放行推送分支（refs/heads/）。");
    }
  }
  return reasons;
}
