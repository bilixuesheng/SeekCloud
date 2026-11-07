# TypeScript monorepo，用户端和管理端合成一个应用

SeekCloud 由一个人主要借助 AI 编程 Agent 开发，部署在 1–2 GB 内存的廉价 VPS 上。因此整套系统都用 TypeScript，放在一个 pnpm monorepo 里：

- 主站：Hono 写 API，用 SSE 推送 Agent 的实时进度；前端是 React + Vite 的 PWA；数据库是 PostgreSQL + Drizzle。
- 沙箱宿主机：跑一个轻量的 TS 守护进程。

用户端和管理端是**同一个应用**。管理端在 `/admin` 路由下，按角色控制访问。这样只需要部署一次，也只占一份内存。

## Considered Options

- **Next.js**：没有采用。整站都在登录之后，SSR 和 SEO 基本用不上；而在小内存 VPS 上，它的运行时和构建开销都偏重。
- **用户端和管理端拆成两个应用**：没有采用。一个人维护两套部署和鉴权，不划算。以后如果需要把管理端单独隔离（比如单独的域名或 IP 白名单），可以在同一个应用前面用反向代理实现，不必拆代码。
