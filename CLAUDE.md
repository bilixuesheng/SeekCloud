# SeekCloud

基于 DeepSeek 的云端编程 Agent 服务，独立第三方，体验对标 Claude Code 网页版。只用英文名 SeekCloud，标志和配色见 `docs/brand/README.md`。

这是开源、自托管版，由收费版迁移而来：只有一个管理员账户，自己部署自己用。

## 先读这些

- `GLOSSARY.md`：领域术语。写文档、写代码、和用户沟通都用这里的叫法。
- `docs/adr/`：改起来代价大的决定，并写明了理由。

## 当前进度

- 代码从 SeekCloud 收费版迁移而来。
- Agent 执行尚未实现：主站还没接上沙箱宿主机，新会话会停在排队。
- **接下来**依次是四个 PR：去掉计费、改成单管理员、改 Agent 的叫法、写 README。
- 之后的新功能先写规格，再拆工单：
  - 网页图形化部署：Linux 一条命令、Windows 一条 PowerShell 命令，其余在网页向导里完成；
  - 多渠道通知：SMTP 邮件、PWA 推送、飞书/钉钉/企业微信机器人、通用 Webhook；
  - 主站和沙箱宿主机都能装在 Windows 上（通过 WSL2）；
  - 安卓 App：第一次打开时输入服务器地址；
  - 管理后台检查更新和一键更新：服务器拉取本仓库。

用户在新会话里说"继续"或者"接着做"时，就从"接下来"开始。每完成一个阶段，更新这一节。

## 开发命令

- 结构：`apps/site`（主站：Hono 接口 + React PWA）、`apps/host`（宿主机守护进程）、`packages/protocol`（共享协议包）。
- 在仓库根目录运行：`pnpm typecheck`、`pnpm lint`（Biome；`pnpm format` 自动修）、`pnpm test`、`pnpm build`。CI 跑的就是这四个。
- 测试要一个 PostgreSQL，默认连 `postgres://postgres:postgres@localhost:5432/postgres`，可以用 `TEST_DATABASE_URL` 改。云端会话里先运行 `service postgresql start`，再用 `runuser -u postgres -- psql -c "ALTER USER postgres PASSWORD 'postgres';"` 设好密码。
- GitHub 的调用全部经过 `apps/site/src/server/github/port.ts` 的接口；测试里是 `t.github`（`src/testing/fake-github.ts`，内存里的假 GitHub）。
- Google 登录走 `apps/site/src/server/google/port.ts` 的接口；测试里是 `t.google`（`src/testing/fake-google.ts`），`t.google.authorize(用户, 授权地址)` 模拟用户在 Google 上同意。GitHub 和 Google 共用的登录、绑定规则在 `src/server/auth/third-party.ts`。
- 人机验证走 `apps/site/src/server/human-check.ts` 的 `HumanCheck` 接口；测试里 `createTestApp({ humanCheck: true })` 打开，用 `t.humanCheck.tokenFor(操作)` 拿令牌，`down()` 模拟主站连不上 Cloudflare。默认不验证。
- 主站和宿主机之间的消息定义在 `packages/protocol`。主站通过 `apps/site/src/server/sessions/host.ts` 的 `HostLink` 和宿主机通信；测试里是 `t.host`（`src/testing/fake-host.ts`，按脚本回放 Agent 事件，`manual = true` 时由测试自己 `emit`）。会话编排在 `src/server/sessions/sessions.ts`。
- 宿主机（`apps/host`）：GitHub 工具服务（MCP，`/mcp`）在 `src/github-tools/`，测试接假的 GitHub API；dsh 怎么接见 `apps/host/sandbox/README.md`。Git 代理在 `src/git-proxy/`，提交签名在 `src/signing/`，沙箱里要装的签名助手和 git 配置在 `apps/host/sandbox/`。测试用真的 `git`（`git http-backend` 当假 GitHub）、`openssl` 和 `ssh-keygen`，云端会话里先运行 `apt-get install -y openssh-client`。生成签名密钥：`pnpm --filter @seekcloud/host signing-key <私钥路径>`，打印出来的公钥加到 SeekCloud 账号的 GitHub 签名密钥里。宿主机的环境变量：`SEEKCLOUD_SIGNING_KEY`（签名私钥路径）、`SEEKCLOUD_SIGNER_EMAIL`（SeekCloud 账号的邮箱）、`SEEKCLOUD_GIT_PROXY_HOST`、`SEEKCLOUD_GIT_PROXY_PORT`、`SEEKCLOUD_HOST_DATA`。
- SSE 接口用 `browser.stream(path)` 测（`src/testing/event-stream.ts`），用完要 `close()`。`t.signUpWithGitHub(login, ...仓库)` 直接得到一个关联了 GitHub、装好 App 的已登录浏览器。
- 主站的测试用 `apps/site/src/testing/test-app.ts` 的 `createTestApp()`：进程内调用接口，每调用一次建一个独立的库（一般一个测试文件一次），时钟、随机数、邮件都是假的。`t.browser()` 模拟一个有自己 Cookie 和 IP 的浏览器。
- 接口出错时统一返回 `{ error: { code, message } }`：`code` 给程序判断，`message` 是给人看的中文。用 `apps/site/src/server/errors.ts` 的 `apiError()`。
- 加表：改 `apps/site/src/server/db/schema.ts`，然后在 `apps/site` 里运行 `pnpm db:generate --name <名字>` 生成迁移。主站启动时自动跑迁移。
- 后台的定期任务在 `apps/site/src/server/maintenance.ts`：打包数据导出、删过期的导出、清理已删除的账户。main.ts 每分钟跑一次；测试里调用 `t.runMaintenance()`，导出的压缩包写在 `t.dataDir`（临时目录）。
- 主站的环境变量：`SEEKCLOUD_DATA_DIR`（主站的数据目录，导出的压缩包放这里，默认 `./data`，要放在会备份的磁盘上）、`DATABASE_URL`、`PORT`（默认 3000）、`SEEKCLOUD_VERSION`、`SEEKCLOUD_SEAT_LIMIT`（内测席位，默认 30）、`RESEND_API_KEY` 和 `MAIL_FROM`（没配就发不了信）、`NODE_ENV=production`（登录 Cookie 只走 HTTPS）、`SEEKCLOUD_SECRET_KEY`（加密令牌用的 32 字节密钥，base64，用 `openssl rand -base64 32` 生成）、`PUBLIC_URL`（主站对外的地址）、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_APP_SLUG`、`GITHUB_WEBHOOK_SECRET`（没配 GitHub 时，GitHub 相关功能直接报错）、`GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`（Google 登录；没配时登录页不显示 Google 按钮，回调地址是 `PUBLIC_URL/api/auth/google/callback`）、`TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY`（Cloudflare Turnstile 人机验证，两个都配才打开；本地试可以用 Cloudflare 的测试密钥 `1x00000000000000000000BB` / `1x0000000000000000000000000000000AA`）。部署时只有一层反向代理，它把客户端地址追加到 `X-Forwarded-For` 末尾；频率限制只认最后一个值。
- 用户协议、隐私政策的正文在 `apps/site/src/client/legal/*.md`。改了协议，同时改 `packages/protocol` 里的 `LEGAL_VERSION`（注册时记在账户上）。加了运行时依赖，要在 `legal/licenses.ts` 的开源声明里补上，有测试检查。
- 建邀请码（管理端做好之前用这个）：在 `apps/site` 里运行 `DATABASE_URL=... pnpm invite:create [--count 数量] [--days 有效天数]`。
- 访问记录（注册、登录、发起会话、发消息时的 IP）在 `apps/site/src/server/access-log.ts`，保存 180 天，删除账户时只断开关联、不删。
- 高峰时段和工作日历在 `apps/site/src/server/billing/peak-hours.ts`，模型网关计费、用量圆环都用它；国务院的放假安排内置在 `billing/holidays.ts`，每年 11 月前后发了下一年的通知就照原文补上。管理端做好之前，按天改工作日历用 `DATABASE_URL=... pnpm calendar:set <YYYY-MM-DD> <workday|off|default>`。测试里是 `t.setWorkday(日期, 是否休息)`。

## 合并授权

Claude 会话在本仓库里开的 PR，合并到 `main` 之前必须先给用户看，用户同意后才合并。

- 合并前先跑一遍仓库现有的检查。CI 没有全部通过时，先修好再合并。
- 合并方式用 squash。
- 合并之后，后续工作从最新的 `main` 重新开分支。
- 发版之前先问用户。

## 和用户协作的方式

- 请用户做决定时，先说明 Claude Code 网页版在这个问题上是怎么做的，再给出你的建议。
- 约时间、设定时提醒一律用洛杉矶时间（America/Los_Angeles）。
- 主动想一想边界情况和异常场景。用户希望在动手之前，把所有问题都理清楚。
- 界面上的文字（包括错误提示、邮件、用户协议和隐私政策）用书面语，照 `docs/brand/README.md` 的"界面文案规范"写，不要口语化。
- 对标的标准是"做全"：Claude Code 网页版里 AI 能调用的功能和体验，SeekCloud 基本都要有。

## Agent skills

### Issue tracker

规格和工单放在本仓库的 GitHub Issues，云端会话里用 GitHub MCP 工具操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

用默认的五个标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单一上下文：根目录一份 `GLOSSARY.md`，加上 `docs/adr/`。见 `docs/agents/domain.md`。
