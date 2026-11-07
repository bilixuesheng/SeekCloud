import type { IncomingMessage, ServerResponse } from "node:http";
import { PROTOCOL_VERSION } from "@seekcloud/protocol";
import { z } from "zod";
import type { GitSession, GitSessions } from "../git-proxy/sessions";
import { GitHubClient, ToolError } from "./client";
import { TOOLS } from "./tools";

/**
 * GitHub 工具服务：以 MCP 服务的形式给沙箱里的 Agent 提供 GitHub 工具。
 *
 * 跑在 Git 代理的端口上（POST /mcp），会话令牌放在 Authorization: Bearer 里，和签名服务一样。
 * 只实现 MCP 的 Streamable HTTP 里用得到的部分：每个 POST 一条（或一批）JSON-RPC 消息，直接回 JSON，
 * 不开 SSE 流，也不用 Mcp-Session-Id（服务本身没有状态，会话靠令牌区分）。
 */
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1024 * 1024;
/** 工具结果太长时截断，免得撑满 Agent 的上下文。 */
const MAX_RESULT_CHARS = 80_000;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const toolList = TOOLS.map((tool) => {
  const { $schema: _, ...inputSchema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema };
});
const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** GitHub 返回的对象里，链接、头像这类对 Agent 没用的字段去掉；用户只留登录名，仓库只留全名。 */
export function slim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slim);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (typeof object.login === "string" && "avatar_url" in object) return object.login;
  if (typeof object.full_name === "string" && "owner" in object && "private" in object) {
    return object.full_name;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(object)) {
    if (key === "_links" || key === "url" || key === "node_id" || key === "reactions") continue;
    if (key.endsWith("_url") && key !== "html_url") continue;
    out[key] = slim(field);
  }
  return out;
}

function resultText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(slim(value), null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n…（结果太长，后面 ${text.length - MAX_RESULT_CHARS} 个字符已省略。可以用分页参数缩小范围）`;
}

async function callTool(client: GitHubClient, params: Record<string, unknown> | undefined) {
  const name = typeof params?.name === "string" ? params.name : "";
  const tool = byName.get(name);
  if (!tool) return { content: [{ type: "text", text: `没有这个工具：${name}` }], isError: true };
  const parsed = tool.schema.safeParse(params?.arguments ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "参数"}：${i.message}`);
    return { content: [{ type: "text", text: `参数不对：${issues.join("；")}` }], isError: true };
  }
  try {
    const value = await tool.run(client, parsed.data as never);
    return { content: [{ type: "text", text: resultText(value) }] };
  } catch (error) {
    if (error instanceof ToolError) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    console.error(
      JSON.stringify({ event: "github-tools.error", tool: name, error: String(error) }),
    );
    return { content: [{ type: "text", text: "工具内部出错，请稍后重试。" }], isError: true };
  }
}

/** 处理一条 JSON-RPC 消息。通知（没有 id）不回复，返回 undefined。 */
export async function handleMessage(
  session: GitSession,
  message: JsonRpcRequest,
  apiBase?: string,
): Promise<unknown> {
  const isNotification = message.id === undefined;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id ?? null, result });
  const fail = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code, message: text },
  });
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return fail(-32600, "不是有效的 JSON-RPC 请求");
  }
  if (isNotification) return undefined;
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      const version =
        typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked)
          ? asked
          : SUPPORTED_VERSIONS[0];
      return reply({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "seekcloud-github", version: PROTOCOL_VERSION },
        instructions:
          "这些工具以用户本人的 GitHub 账号操作当前会话挂载的仓库。写到 GitHub 上的正文会自动加署名，不用自己写。",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolList });
    case "tools/call":
      return reply(await callTool(new GitHubClient(session, apiBase), message.params));
    default:
      return fail(-32601, `不支持的方法：${message.method}`);
  }
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** POST /mcp。 */
export async function handleMcpHttp(
  sessions: GitSessions,
  req: IncomingMessage,
  res: ServerResponse,
  apiBase?: string,
): Promise<void> {
  if (req.method !== "POST") {
    // 不提供服务端主动推送的 SSE 流，也没有要结束的会话。
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  const auth = req.headers.authorization ?? "";
  const session = auth.startsWith("Bearer ") ? sessions.byToken(auth.slice(7)) : undefined;
  if (!session) return send(res, 401, { error: "会话令牌不对，或者会话已经结束" });

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return send(res, 413, { error: "请求体太大" });
    chunks.push(chunk as Buffer);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "不是 JSON" },
    });
  }
  const messages = (Array.isArray(payload) ? payload : [payload]) as JsonRpcRequest[];
  const replies = (
    await Promise.all(messages.map((m) => handleMessage(session, m, apiBase)))
  ).filter((r) => r !== undefined);
  // 全是通知：202，没有正文。
  if (replies.length === 0) return send(res, 202);
  send(res, 200, Array.isArray(payload) ? replies : replies[0]);
}
