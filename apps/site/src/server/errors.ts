import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { GitHubError } from "./github/port";

/** 接口出错时统一的返回格式：错误码给程序判断用，说明是给人看的中文。 */
export function apiError(code: string, message: string) {
  return { error: { code, message } };
}

export const notLoggedIn = apiError("unauthorized", "请先登录");

export const githubNotConnected = apiError(
  "github_not_connected",
  "尚未关联 GitHub 或授权已失效，请重新关联",
);

export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** OpenAPI 里一条错误响应的描述。 */
export function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: ErrorBody } } };
}

/** 框架或中间件抛出的异常，也按统一格式返回。 */
export function handleError(error: Error, c: Context) {
  if (error instanceof HTTPException) {
    if (error.status === 403) {
      return c.json(apiError("forbidden", "拒绝来自其他站点的请求"), 403);
    }
    if (error.status === 400) return c.json(apiError("invalid_request", "请求格式错误"), 400);
    return c.json(apiError("request_failed", "请求失败"), error.status);
  }
  console.error(error);
  if (error instanceof GitHubError) {
    return c.json(apiError("github_unavailable", "GitHub 暂时无法访问，请稍后重试"), 502);
  }
  return c.json(apiError("internal_error", "服务器错误，请稍后重试"), 500);
}
