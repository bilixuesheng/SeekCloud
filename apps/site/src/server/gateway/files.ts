import { and, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import { modelFiles } from "../db/schema";
import { errorResponse, recordUpstreamFailure } from "./failures";
import type { GatewayDeps } from "./gateway";
import { sendUpstream } from "./upstream";

/** 上传一个文件最多等这么久（图片一般几百 KB）。 */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const DELETE_TIMEOUT_MS = 60_000;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 1000;

type Owner = { userId: string | null; sessionId: string };
type FileRow = typeof modelFiles.$inferSelect;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const notFound = () =>
  errorResponse({
    code: "model_rejected",
    status: 404,
    message: "文件不存在，或者不是这个会话上传的",
  });

/** 给沙箱看的文件信息（Anthropic Files 接口的格式），只有这几项。 */
function fileObject(row: FileRow) {
  return {
    type: "file",
    id: row.id,
    filename: row.filename,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    created_at: row.uploadedAt.toISOString(),
    downloadable: false,
  };
}

/**
 * 沙箱的 Files 接口（#26）：dsh 把要给模型看的图片传上去，Messages 里按文件 ID 引用。
 *
 * 文件转给提供方存，同一把 key 下所有会话的文件都在一起，所以网关自己记每个文件是哪个会话传的
 * （model_files）：列表、查看、删除都只看得到本会话的，Messages 里也只能引用本会话的（referencedFiles）。
 * 不提供下载文件内容（/v1/files/{id}/content）：传上去的只有沙箱自己有的东西，不需要再取回来。
 */
export class GatewayFiles {
  readonly #deps: GatewayDeps;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
  }

  /** POST /v1/files：multipart 的请求体原样转给提供方，不先读进内存。 */
  async upload(
    owner: Owner,
    request: { headers: Headers; body: ReadableStream<Uint8Array> | null; signal: AbortSignal },
  ): Promise<Response> {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data") || !request.body) {
      return errorResponse({
        code: "model_rejected",
        status: 400,
        message: "上传文件要用 multipart/form-data",
      });
    }
    const targets = await this.#deps.providerRouting.service({ service: "files", ...owner });
    const sent = await sendUpstream(this.#deps, owner, targets, {
      method: "POST",
      path: "/v1/files",
      incoming: request.headers,
      contentType,
      body: request.body,
      signal: request.signal,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (!sent.ok) return errorResponse(sent.failure);
    let row: FileRow;
    try {
      const file = (await sent.response.json()) as Record<string, unknown>;
      const uploadedAt = typeof file.created_at === "string" ? new Date(file.created_at) : null;
      if (
        typeof file.id !== "string" ||
        !file.id ||
        typeof file.filename !== "string" ||
        typeof file.mime_type !== "string" ||
        typeof file.size_bytes !== "number" ||
        !uploadedAt ||
        Number.isNaN(uploadedAt.getTime())
      ) {
        throw new Error("缺少 id、filename、mime_type、size_bytes 或 created_at");
      }
      [row] = (await this.#deps.db
        .insert(modelFiles)
        .values({
          id: file.id,
          provider: sent.target.provider,
          userId: owner.userId,
          sessionId: owner.sessionId,
          filename: file.filename,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          uploadedAt,
          createdAt: this.#deps.clock.now(),
        })
        .returning()) as [FileRow];
    } catch (error) {
      const failure = await recordUpstreamFailure(this.#deps, owner, sent.target.provider, {
        status: null,
        body: `Files 接口返回的内容看不懂：${String(error)}`,
        code: "model_unavailable",
      });
      return errorResponse(failure);
    } finally {
      sent.done();
    }
    return json(fileObject(row));
  }

  /** GET /v1/files：本会话传过的文件，新的在前。after_id、before_id 翻页（Anthropic 的写法）。 */
  async list(owner: Owner, query: URLSearchParams): Promise<Response> {
    const limitText = query.get("limit");
    const limit = limitText === null ? DEFAULT_LIST_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      return errorResponse({
        code: "model_rejected",
        status: 400,
        message: `limit 要是 1 到 ${MAX_LIST_LIMIT} 之间的整数`,
      });
    }
    const mine = eq(modelFiles.sessionId, owner.sessionId);
    // 排序是"上传时间新的在前，同一时刻按 ID 倒序"：after_id 往后翻（更旧的），before_id 往前翻（更新的）。
    const afterId = query.get("after_id");
    const beforeId = query.get("before_id");
    let where = mine;
    const newerFirst = !beforeId;
    const cursorId = afterId ?? beforeId;
    if (cursorId) {
      const cursor = await this.#find(owner, cursorId);
      if (!cursor) return notFound();
      const at = modelFiles.uploadedAt;
      const beyond = afterId
        ? or(
            lt(at, cursor.uploadedAt),
            and(eq(at, cursor.uploadedAt), lt(modelFiles.id, cursor.id)),
          )
        : or(
            gt(at, cursor.uploadedAt),
            and(eq(at, cursor.uploadedAt), gt(modelFiles.id, cursor.id)),
          );
      where = and(mine, beyond) as typeof mine;
    }
    const rows = await this.#deps.db
      .select()
      .from(modelFiles)
      .where(where)
      .orderBy(
        newerFirst ? desc(modelFiles.uploadedAt) : modelFiles.uploadedAt,
        newerFirst ? desc(modelFiles.id) : modelFiles.id,
      )
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    if (!newerFirst) page.reverse();
    return json({
      data: page.map(fileObject),
      first_id: page[0]?.id ?? null,
      last_id: page.at(-1)?.id ?? null,
      has_more: rows.length > limit,
    });
  }

  /** GET /v1/files/{id}：只看本会话的。 */
  async retrieve(owner: Owner, id: string): Promise<Response> {
    const row = await this.#find(owner, id);
    return row ? json(fileObject(row)) : notFound();
  }

  /** DELETE /v1/files/{id}：只删本会话的。提供方那边已经没有了（过期）也算删掉。 */
  async delete(
    owner: Owner,
    id: string,
    request: { headers: Headers; signal: AbortSignal },
  ): Promise<Response> {
    const row = await this.#find(owner, id);
    if (!row) return notFound();
    const targets = (
      await this.#deps.providerRouting.service({ service: "files", ...owner })
    ).filter((t) => t.provider === row.provider);
    const doFetch = this.#deps.modelFetch ?? fetch;
    const target = targets[0];
    if (target) {
      const path = `/v1/files/${encodeURIComponent(id)}`;
      let status: number | null = null;
      let body = "";
      try {
        const res = await doFetch(target.url(path), {
          method: "DELETE",
          headers: target.headers(path, request.headers),
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(DELETE_TIMEOUT_MS)]),
        });
        status = res.status;
        body = res.ok || res.status === 404 ? "" : await res.text();
      } catch (error) {
        body = String(error);
      }
      if (status === null || (status >= 400 && status !== 404)) {
        if (request.signal.aborted) {
          return errorResponse({ code: "internal", status: 499, message: "请求已取消" });
        }
        return errorResponse(
          await recordUpstreamFailure(this.#deps, owner, target.provider, { status, body }),
        );
      }
    }
    // 提供方不在了（换了提供方、删了 key）：文件在那边也用不了，这里的记录照删。
    await this.#deps.db.delete(modelFiles).where(eq(modelFiles.id, row.id));
    return json({ id: row.id, type: "file_deleted" });
  }

  /**
   * Messages 请求里引用的文件：都得是本会话传的。返回这些文件在哪些提供方（网关只用它们），
   * 有不认识的就返回 undefined（整个请求拒绝）。没引用文件时返回 null。
   */
  async referencedProviders(owner: Owner, body: Record<string, unknown>) {
    const ids = referencedFileIds(body);
    if (ids.size === 0) return null;
    const rows = await this.#deps.db
      .select({ id: modelFiles.id, provider: modelFiles.provider })
      .from(modelFiles)
      .where(and(eq(modelFiles.sessionId, owner.sessionId), inArray(modelFiles.id, [...ids])));
    if (rows.length !== ids.size) return undefined;
    const providers = new Set(rows.map((r) => r.provider));
    // 引用的文件分在不同的提供方：哪一家都凑不齐。
    return providers.size === 1 ? providers : undefined;
  }

  async #find(owner: Owner, id: string): Promise<FileRow | undefined> {
    const [row] = await this.#deps.db
      .select()
      .from(modelFiles)
      .where(and(eq(modelFiles.id, id), eq(modelFiles.sessionId, owner.sessionId)));
    return row;
  }
}

/**
 * Messages 请求里按 ID 引用的文件：消息内容里图片、文档块的 source（type 为 file），
 * 以及工具结果里嵌着的这类块。只按 Anthropic 的结构找，不在工具参数这类任意 JSON 里找。
 */
export function referencedFileIds(body: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const visit = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      const source = b.source as Record<string, unknown> | undefined;
      if (source?.type === "file" && typeof source.file_id === "string") ids.add(source.file_id);
      if (b.type === "container_upload" && typeof b.file_id === "string") ids.add(b.file_id);
      if (b.type === "tool_result") visit(b.content);
    }
  };
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (typeof message === "object" && message !== null) {
        visit((message as { content?: unknown }).content);
      }
    }
  }
  return ids;
}
