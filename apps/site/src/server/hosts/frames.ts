import {
  ERROR_CODES,
  type HostEvent,
  type HostHello,
  type HostReport,
  MAX_AGENT_ARCHIVE_BASE64,
  MAX_FILE_PATCH_BYTES,
  MAX_LISTED_FILES,
  TURN_END_REASONS,
} from "@seekcloud/protocol";
import { z } from "zod";

/**
 * 宿主机发来的帧逐个校验：主站不信宿主机（它跑着别人的代码），格式不对的不往下交。
 * 协议加了新的事件类型、旧主站还不认识时（PROTOCOL_VERSION 的规矩）：parseEvent 返回 "unknown"，
 * 主站记一笔、照样确认，免得宿主机一直补发。
 */

const Id = z.string().min(1).max(100);
const Count = z.number().int().nonnegative();
const Bytes = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);

const SafeErrorShape = z.object({
  code: z.enum(ERROR_CODES),
  status: z.number().int().min(100).max(599).optional(),
  ref: z.string().max(100).optional(),
});

const AgentEventShape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn.started") }),
  z.object({ type: z.literal("message"), text: z.string(), thinking: z.string().optional() }),
  z.object({
    type: z.literal("tool.call"),
    callId: Id,
    name: z.string().max(200),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool.result"),
    callId: Id,
    output: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("todo"),
    items: z.array(
      z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    ),
  }),
  z.object({
    type: z.literal("workspace"),
    repos: z
      .array(
        z.object({
          fullName: z.string().max(200),
          head: z.string().regex(/^[0-9a-f]{40,64}$/),
          savedCommit: z
            .string()
            .regex(/^[0-9a-f]{40,64}$/)
            .optional(),
          push: z.enum(["pushed", "read_only", "failed"]),
          error: z.string().max(4000).optional(),
          files: z
            .array(
              z.object({
                path: z.string().max(4096),
                from: z.string().max(4096).optional(),
                additions: Count,
                deletions: Count,
                binary: z.boolean().optional(),
              }),
            )
            .max(MAX_LISTED_FILES),
          omittedFiles: Count.optional(),
        }),
      )
      .max(50),
  }),
  z.object({
    type: z.literal("turn.ended"),
    reason: z.enum(TURN_END_REASONS),
    error: SafeErrorShape.optional(),
  }),
]);

const Sha = z.string().regex(/^[0-9a-f]{40,64}$/);

const FileChangeShape = z.object({
  path: z.string().max(4096),
  from: z.string().max(4096).optional(),
  additions: Count,
  deletions: Count,
  binary: z.boolean().optional(),
});

const HostEventShape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sandbox.ready"), sessionId: Id }),
  z.object({
    type: z.literal("agent.archive"),
    sessionId: Id,
    turnId: Id,
    data: z.string().max(MAX_AGENT_ARCHIVE_BASE64),
  }),
  z.object({
    type: z.literal("workspace.diff"),
    sessionId: Id,
    turnId: Id,
    repos: z
      .array(
        z.object({
          fullName: z.string().max(200),
          baseBranch: z.string().max(255),
          base: Sha,
          head: Sha,
          files: z
            .array(
              FileChangeShape.extend({
                // 多给一点余量：宿主机按字节算，这里按字符数
                patch: z
                  .string()
                  .max(MAX_FILE_PATCH_BYTES * 2)
                  .optional(),
                tooLarge: z.boolean().optional(),
              }),
            )
            .max(MAX_LISTED_FILES),
          truncated: z.boolean().optional(),
        }),
      )
      .max(50),
  }),
  z.object({ type: z.literal("sandbox.failed"), sessionId: Id, error: SafeErrorShape }),
  z.object({ type: z.literal("agent"), sessionId: Id, turnId: Id, event: AgentEventShape }),
  z.object({
    type: z.literal("progress"),
    sessionId: Id,
    turnId: Id,
    phase: z.enum(["thinking", "text"]),
    tokens: Count,
  }),
  z.object({
    type: z.literal("delta"),
    sessionId: Id,
    turnId: Id,
    kind: z.enum(["thinking", "text"]),
    text: z.string(),
  }),
]);

const KNOWN_EVENTS = new Set(HostEventShape.options.map((o) => o.shape.type.value));

const ReportShape = z.object({
  load: z.number().nonnegative(),
  cpus: Count,
  memoryAvailable: Bytes,
  memoryTotal: Bytes,
  diskAvailable: Bytes,
  diskTotal: Bytes,
  sandboxes: Count,
  diskQuota: z.boolean().optional(),
});

const HelloShape = z.object({
  hello: z.object({
    key: z.string().max(200),
    protocol: z.number().int().positive(),
    minProtocol: z.number().int().positive(),
    version: z.string().max(100),
    instance: z.string().min(1).max(100),
    ack: Count,
  }),
});

function json(data: unknown): unknown {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}

/** 第一帧：握手。格式不对返回 undefined。 */
export function parseHello(data: unknown): HostHello | undefined {
  const parsed = HelloShape.safeParse(json(data));
  return parsed.success ? parsed.data : undefined;
}

/** 握手以后的一帧。 */
export type IncomingFrame =
  | { ack: number; seq: number; event: HostEvent | "unknown" | "invalid" }
  | { ack: number; report: HostReport }
  | { ack: number };

/** 外层（ack、seq）不对返回 undefined，连接应当断开；事件本身不对只把它标成 "invalid"，照样确认。 */
export function parseFrame(data: unknown): IncomingFrame | undefined {
  const raw = json(data);
  if (typeof raw !== "object" || raw === null) return undefined;
  const ack = Count.safeParse((raw as { ack?: unknown }).ack);
  if (!ack.success) return undefined;
  if ("event" in raw) {
    const seq = z
      .number()
      .int()
      .positive()
      .safeParse((raw as { seq?: unknown }).seq);
    if (!seq.success) return undefined;
    const body = (raw as { event: unknown }).event;
    const type = (body as { type?: unknown } | null)?.type;
    if (typeof type === "string" && !KNOWN_EVENTS.has(type as never)) {
      return { ack: ack.data, seq: seq.data, event: "unknown" };
    }
    const event = HostEventShape.safeParse(body);
    return {
      ack: ack.data,
      seq: seq.data,
      event: event.success ? (event.data as HostEvent) : "invalid",
    };
  }
  if ("report" in raw) {
    const report = ReportShape.safeParse((raw as { report: unknown }).report);
    return report.success ? { ack: ack.data, report: report.data } : { ack: ack.data };
  }
  return { ack: ack.data };
}
