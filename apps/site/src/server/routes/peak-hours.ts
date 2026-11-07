import { createRoute, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app";
import { currentUser } from "../auth/login-sessions";
import { loadWorkdayCalendar, peakStatus } from "../billing/peak-hours";
import { errorResponse, notLoggedIn } from "../errors";
import { newRouter } from "./router";

const peakHoursRoute = createRoute({
  method: "get",
  path: "/peak-hours",
  summary: "现在是高峰还是空闲",
  responses: {
    200: {
      description: "峰谷状态",
      content: {
        "application/json": {
          schema: z.object({
            peak: z.boolean().openapi({ description: "true 表示高峰（用量 ×2）" }),
            nextSwitchAt: z
              .string()
              .openapi({ format: "date-time", description: "下一次在高峰和空闲之间切换的时刻" }),
            today: z.object({
              date: z.string().openapi({ description: "北京时间的日期，YYYY-MM-DD" }),
              kind: z.enum(["workday", "weekend", "holiday", "makeup_workday"]).openapi({
                description: "工作日、周末、节假日（含调休放假）、调休上班日",
              }),
              name: z.string().nullable().openapi({ description: "节日名，比如春节" }),
            }),
          }),
        },
      },
    },
    401: errorResponse("没有登录"),
  },
});

export function peakHoursRoutes(deps: AppDeps) {
  return newRouter().openapi(peakHoursRoute, async (c) => {
    if (!(await currentUser(deps, c))) return c.json(notLoggedIn, 401);
    const status = peakStatus(deps.clock.now(), await loadWorkdayCalendar(deps));
    const { date, kind, name } = status.today;
    return c.json(
      {
        peak: status.peak,
        nextSwitchAt: status.nextSwitchAt.toISOString(),
        today: { date, kind, name },
      },
      200,
    );
  });
}
