import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import {
  downloadableExport,
  EXPORT_INTERVAL_MS,
  type ExportRow,
  exportOverview,
  requestExport,
} from "../account/exports";
import type { AppDeps } from "../app";
import { currentUser } from "../auth/login-sessions";
import { apiError, errorResponse, notLoggedIn } from "../errors";
import { jsonBody as json, newRouter } from "./router";

const ExportView = z.object({
  id: z.string(),
  status: z.enum(["pending", "building", "ready", "failed", "expired"]),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  sizeBytes: z.number().nullable(),
});

const ExportOverview = z.object({
  latest: ExportView.nullable().openapi({ description: "最近一次导出；没导出过为 null" }),
  nextAvailableAt: z
    .string()
    .nullable()
    .openapi({ description: "什么时候可以再导出；null 表示现在就可以" }),
});

const exportStatusRoute = createRoute({
  method: "get",
  path: "/export",
  summary: "导出数据的状态",
  responses: {
    200: { description: "状态", ...json(ExportOverview) },
    401: errorResponse("没有登录"),
  },
});

const exportRequestRoute = createRoute({
  method: "post",
  path: "/export",
  summary: "申请导出数据",
  description: "后台打包，好了在设置里下载，24 小时内有效。每 24 小时只能申请一次，没打成的不算。",
  responses: {
    202: { description: "已申请", ...json(ExportOverview) },
    401: errorResponse("没有登录"),
    429: errorResponse("24 小时内已经导出过"),
  },
});

const exportDownloadRoute = createRoute({
  method: "get",
  path: "/export/{id}/download",
  summary: "下载导出的压缩包",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "压缩包", content: { "application/zip": { schema: z.any() } } },
    401: errorResponse("没有登录"),
    404: errorResponse("没有这个导出，或者已经过期"),
  },
});

const exportView = (row: ExportRow) => ({
  id: row.id,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
  sizeBytes: row.sizeBytes,
});

/** 账户设置：导出数据。 */
export function accountRoutes(deps: AppDeps) {
  const overview = async (userId: string) => {
    const { latest, nextAvailableAt } = await exportOverview(deps, userId);
    return {
      latest: latest && exportView(latest),
      nextAvailableAt: nextAvailableAt?.toISOString() ?? null,
    };
  };
  return newRouter()
    .openapi(exportStatusRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      return c.json(await overview(me.id), 200);
    })
    .openapi(exportRequestRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const result = await requestExport(deps, me.id);
      if (!result.ok) {
        const wait = result.nextAvailableAt.getTime() - deps.clock.now().getTime();
        c.header("Retry-After", String(Math.ceil(Math.max(wait, 0) / 1000)));
        return c.json(
          apiError(
            "export_too_soon",
            `每 ${EXPORT_INTERVAL_MS / 3_600_000} 小时仅可导出一次，请稍后重试`,
          ),
          429,
        );
      }
      return c.json(await overview(me.id), 202);
    })
    .openapi(exportDownloadRoute, async (c) => {
      const me = await currentUser(deps, c);
      if (!me) return c.json(notLoggedIn, 401);
      const file = await downloadableExport(deps, me.id, c.req.valid("param").id);
      if (!file) return c.json(apiError("export_not_found", "导出不存在或已过期"), 404);
      const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream;
      return c.body(body, 200, {
        "content-type": "application/zip",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
      }) as never;
    });
}
