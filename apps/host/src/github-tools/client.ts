import { type AiLabels, DEFAULT_AI_LABELS } from "@seekcloud/protocol";
import { checkCreateRef, checkRequest, findRepo, type MountedRepo } from "../git-proxy/rules";
import type { GitSession } from "../git-proxy/sessions";

/** 工具出错：消息原样交给 Agent，所以只写 Agent 能据此改正的内容。 */
export class ToolError extends Error {
  /** GitHub 返回的状态码；不是 GitHub 报的错就没有。 */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface RestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 要原始文本（比如 diff）时换成对应的 Accept。 */
  accept?: string;
  /** 返回原始文本，不当 JSON 解析（比如作业日志）。 */
  raw?: boolean;
}

interface SendOptions extends RestOptions {
  headers?: Record<string, string>;
}

/**
 * 代表某个会话调用 GitHub。
 * - REST：每个请求先过 Git 代理的同一套规则（checkRequest）：只能碰本会话挂载的仓库，写操作只放行白名单。
 *   工具不会比沙箱里的 gh 能做更多的事。
 * - GraphQL 和搜索没法按地址检查范围，所以不对外开放，只给几个写死的操作用（graphql()、search()），
 *   由调用方先确认涉及的仓库挂载在本会话上。
 */
export class GitHubClient {
  readonly #session: GitSession;
  readonly #apiBase: string;

  constructor(session: GitSession, apiBase = "https://api.github.com") {
    this.#session = session;
    this.#apiBase = apiBase.replace(/\/$/, "");
  }

  get repos(): MountedRepo[] {
    return this.#session.repos;
  }

  /** AI 标识的两个开关。每次用到时现取：管理员中途改了，下一次调用就生效。 */
  get aiLabels(): AiLabels {
    return this.#session.aiLabels ?? DEFAULT_AI_LABELS;
  }

  /** 仓库挂载在本会话上；需要写时还要求是可推送的。返回规范的 owner/name。 */
  requireRepo(fullName: string, write = false): MountedRepo {
    const [owner = "", name = ""] = fullName.split("/");
    const repo = findRepo(this.repos, owner, name);
    if (!repo) {
      throw new ToolError(`仓库 ${fullName} 没有挂载到当前会话，不能操作（公开仓库也要先挂载）。`);
    }
    if (write && repo.access !== "push") {
      throw new ToolError(`仓库 ${repo.fullName} 是只读挂载的，只能读，不能改。`);
    }
    return repo;
  }

  async rest<T = unknown>(method: string, path: string, options: RestOptions = {}): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    let decision = checkRequest(this.repos, { host: "api.github.com", method, path, query });
    // 建引用要看请求体：建分支放行，建标签不放行（和代理一样）。
    if (decision.allow && decision.inspect === "create-ref") {
      decision = checkCreateRef(JSON.stringify(options.body ?? {}));
    }
    if (!decision.allow) throw new ToolError(decision.message);
    return this.#send<T>(method, `${path}${query.size ? `?${query}` : ""}`, options);
  }

  /**
   * 写死的 GraphQL 查询。只有本模块里确认过仓库范围的操作能调用。
   * features：还在预览的字段要在 GraphQL-Features 头里声明（比如 issue 字段）。
   */
  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    features: string[] = [],
  ): Promise<T> {
    const result = await this.#send<{ data?: T; errors?: Array<{ message: string }> }>(
      "POST",
      "/graphql",
      {
        body: { query, variables },
        headers: features.length ? { "graphql-features": features.join(",") } : {},
      },
    );
    if (result.errors?.length) {
      throw new ToolError(`GitHub 拒绝了请求：${result.errors.map((e) => e.message).join("；")}`);
    }
    if (!result.data) throw new ToolError("GitHub 没有返回数据");
    return result.data;
  }

  /** 搜索：调用方已经把查询限定在本会话的仓库里（见 tools.ts 的 scopedQuery）。 */
  async search<T>(kind: "code" | "issues", q: string, page?: number, perPage?: number) {
    const query = new URLSearchParams({ q });
    if (page) query.set("page", String(page));
    if (perPage) query.set("per_page", String(perPage));
    return this.#send<T>("GET", `/search/${kind}?${query}`, {});
  }

  async #send<T>(method: string, pathAndQuery: string, options: SendOptions): Promise<T> {
    const token = this.#session.githubToken;
    if (!token) throw new ToolError("当前会话还没有可用的 GitHub 授权，请稍后重试。");
    let res: Response;
    try {
      res = await fetch(`${this.#apiBase}${pathAndQuery}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: options.accept ?? "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "SeekCloud-GitHub-Tools",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // 作业日志会跳到 GitHub 的存储地址，跟着跳过去取。
        redirect: "follow",
      });
    } catch {
      throw new ToolError("暂时无法连接 GitHub，请稍后重试。");
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 500);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // 不是 JSON：用原文。
      }
      throw new ToolError(`GitHub 返回 ${res.status}：${message}`, res.status);
    }
    if (options.raw || (options.accept && !options.accept.includes("json"))) return text as T;
    return (text ? JSON.parse(text) : null) as T;
  }
}
