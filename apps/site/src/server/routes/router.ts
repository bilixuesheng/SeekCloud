import { OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError } from "../errors";

// 校验失败时 zod 默认的说明是英文，换成中文。
z.config(z.locales.zhCN());

/** OpenAPI 里一个 JSON 请求体或响应体的描述。 */
export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

/** 所有路由都从这里建：请求格式不对时，按统一的错误格式返回 400。 */
export function newRouter() {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues[0]?.message ?? "请求格式错误";
        return c.json(apiError("invalid_request", message), 400);
      }
    },
  });
}
