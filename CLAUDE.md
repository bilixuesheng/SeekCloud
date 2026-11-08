# SeekCloud

基于 DeepSeek 的云端编程 Agent 服务，独立第三方，体验对标 Claude Code 网页版。只用英文名 SeekCloud，标志和配色见 `docs/brand/README.md`。

这是开源、自托管版，由原定后由于法规原因废弃的收费版迁移而来：只有一个管理员账户，自己部署自己用。

## 先读这些

- `GLOSSARY.md`：领域术语。写文档、写代码、和用户沟通都用这里的叫法。
- `docs/adr/`：改起来代价大的决定，并写明了理由。

## 当前进度

- 代码从 SeekCloud 收费版迁移而来，已经去掉计费、改成单管理员（ADR 0008）、改了 Agent 的叫法（ADR 0004），也写好了 README。
- Agent 执行尚未实现：主站还没接上沙箱宿主机，新会话会停在排队。
- **接下来**从新功能的规格开始，每项先写规格，再拆工单：
  - 网页图形化部署：Linux 一条命令、Windows 一条 PowerShell 命令，其余在网页向导里完成；
  - 多渠道通知：SMTP 邮件、PWA 推送、飞书/钉钉/企业微信机器人、通用 Webhook；
  - 主站和沙箱宿主机都能装在 Windows 上（通过 WSL2）；
  - 安卓 App：第一次打开时输入服务器地址；
  - 管理后台检查更新和一键更新：服务器拉取本仓库；
  - 开放 dsh 原来砍掉的功能：插件市场、几种模式（比如创造模式）、轨迹视图等；
  - Agent 在 GitHub 上的 AI 标识（issue、PR 和评论的署名，以及提交尾注）默认加上，可以在设置里关掉。

用户在新会话里说"继续"或者"接着做"时，就从"接下来"开始。每完成一个阶段，更新这一节。

## 开发命令

- 结构：`apps/site`（主站：Hono 接口 + React PWA）、`apps/host`（宿主机守护进程）、`packages/protocol`（共享协议包）。
- 在仓库根目录运行：`pnpm typecheck`、`pnpm lint`（Biome；`pnpm format` 自动修）、`pnpm test`、`pnpm build`。CI 跑的就是这四个。
- 测试要一个 PostgreSQL，默认连 `postgres://postgres:postgres@localhost:5432/postgres`，可以用 `TEST_DATABASE_URL` 改。云端会话里先运行 `service postgresql start`，再用 `runuser -u postgres -- psql -c "ALTER USER postgres PASSWORD 'postgres';"` 设好密码。
- GitHub 的调用全部经过 `apps/site/src/server/github/port.ts` 的接口；测试里是 `t.github`（`src/testing/fake-github.ts`，内存里的假 GitHub）。
- 登录：只有一个管理员账户，只用密码登录（ADR 0008）。设置、登录、改密码、重置在 `apps/site/src/server/auth/admin.ts`，密码只存 scrypt 哈希（`auth/password.ts`）；同一个 IP 一小时输错 10 次就暂停。GitHub 不是登录方式，只在设置里关联（`src/server/github/link.ts`）。
- 主站和宿主机之间的消息定义在 `packages/protocol`。主站通过 `apps/site/src/server/sessions/host.ts` 的 `HostLink` 和宿主机通信；测试里是 `t.host`（`src/testing/fake-host.ts`，按脚本回放 Agent 事件，`manual = true` 时由测试自己 `emit`）。会话编排在 `src/server/sessions/sessions.ts`。
- 宿主机（`apps/host`）：GitHub 工具服务（MCP，`/mcp`）在 `src/github-tools/`，测试接假的 GitHub API；dsh 怎么接见 `apps/host/sandbox/README.md`。Git 代理在 `src/git-proxy/`，提交签名在 `src/signing/`，沙箱里要装的签名助手和 git 配置在 `apps/host/sandbox/`。测试用真的 `git`（`git http-backend` 当假 GitHub）、`openssl` 和 `ssh-keygen`，云端会话里先运行 `apt-get install -y openssh-client`。生成签名密钥：`pnpm --filter @seekcloud/host signing-key <私钥路径>`，打印出来的公钥加到 SeekCloud 账号的 GitHub 签名密钥里。宿主机的环境变量：`SEEKCLOUD_SIGNING_KEY`（签名私钥路径）、`SEEKCLOUD_SIGNER_EMAIL`（SeekCloud 账号的邮箱）、`SEEKCLOUD_GIT_PROXY_HOST`、`SEEKCLOUD_GIT_PROXY_PORT`、`SEEKCLOUD_HOST_DATA`。
- SSE 接口用 `browser.stream(path)` 测（`src/testing/event-stream.ts`），用完要 `close()`。`t.admin()` 得到一个已登录的管理员浏览器（第一次调用时用 `t.adminPassword` 设置密码，每次调用都是一台新设备）；`t.adminWithGitHub(login, ...仓库)` 再关联 GitHub、装好 App，再调用一次会换成新的 GitHub 账号。
- 主站的测试用 `apps/site/src/testing/test-app.ts` 的 `createTestApp()`：进程内调用接口，每调用一次建一个独立的库（一般一个测试文件一次），时钟是假的。`t.browser()` 模拟一个有自己 Cookie 和 IP 的浏览器。
- 接口出错时统一返回 `{ error: { code, message } }`：`code` 给程序判断，`message` 是给人看的中文。用 `apps/site/src/server/errors.ts` 的 `apiError()`。
- 加表：改 `apps/site/src/server/db/schema.ts`，然后在 `apps/site` 里运行 `pnpm db:generate --name <名字>` 生成迁移。主站启动时自动跑迁移。
- 后台的定期任务在 `apps/site/src/server/maintenance.ts`：打包数据导出、删过期的导出、删满 180 天的访问记录。main.ts 每分钟跑一次；测试里调用 `t.runMaintenance()`，导出的压缩包写在 `t.dataDir`（临时目录）。
- 主站的环境变量：`SEEKCLOUD_DATA_DIR`（主站的数据目录，导出的压缩包放这里，默认 `./data`，要放在会备份的磁盘上）、`DATABASE_URL`、`PORT`（默认 3000）、`SEEKCLOUD_VERSION`、`NODE_ENV=production`（登录 Cookie 只走 HTTPS）、`SEEKCLOUD_SECRET_KEY`（加密令牌用的 32 字节密钥，base64，用 `openssl rand -base64 32` 生成）、`PUBLIC_URL`（主站对外的地址）、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_APP_SLUG`、`GITHUB_WEBHOOK_SECRET`（没配 GitHub 时，GitHub 相关功能直接报错）。部署时只有一层反向代理，它把客户端地址追加到 `X-Forwarded-For` 末尾；频率限制只认最后一个值。
- 许可证是 AGPL-3.0，加了署名附加条款（ADR 0009，条款原文在 `NOTICE`）。不要拷贝许可证和 AGPL-3.0 不兼容的代码；借用 DSH Go 的代码要保留它的版权声明。
- 加了运行时依赖，要在 `apps/site/src/client/legal/licenses.ts` 的开源声明里补上，有测试检查。开源声明页开头 SeekCloud 自己的署名（`legal/LegalPage.tsx`）不能删，这是附加条款要求的。
- 忘记管理员密码：在 `apps/site` 里运行 `DATABASE_URL=... pnpm admin:reset-password`，打印一个随机的新密码，所有设备退出登录。
- 访问记录（登录、发起会话、发消息时的 IP）在 `apps/site/src/server/access-log.ts`，保存 180 天。
- README 有中英两份（`README.md`、`README.en.md`），改的时候两份一起改。
- 提交信息按"类型: 说明"写：类型按改动性质选（feat、fix、docs、style、refactor、test、chore 等），说明用中文，例如 `fix: 行内代码的背景跟着文字一起浮现`。PR 的 squash 合并标题也照这个格式（2026-11-08 用户要求）。

## 合并授权

Claude 会话在本仓库里开的 PR，写好、CI 全部通过后直接 squash 合并到 `main`，不用再等用户看（2026-11-08 用户要求）。

- 合并前先跑一遍仓库现有的检查。CI 没有全部通过时，先修好再合并。
- 合并之后，后续工作从最新的 `main` 重新开分支。
- 发版之前先问用户。

## 和用户协作的方式

- 请用户做决定时，先说明 Claude Code 网页版在这个问题上是怎么做的，再给出你的建议。
- 涉及 Agent 能力的决定，先查 dsh 原版有没有这个功能，再问用户（2026-11-08 用户要求）。
- 约时间、设定时提醒一律用洛杉矶时间（America/Los_Angeles）。
- 主动想一想边界情况和异常场景。用户希望在动手之前，把所有问题都理清楚。
- 界面上的文字（包括错误提示）用书面语，照 `docs/brand/README.md` 的"界面文案规范"写，不要口语化。
- 对标的标准是"做全"：Claude Code 网页版里 AI 能调用的功能和体验，SeekCloud 基本都要有。

## Agent skills

### Issue tracker

规格和工单放在本仓库的 GitHub Issues，云端会话里用 GitHub MCP 工具操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

用默认的五个标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单一上下文：根目录一份 `GLOSSARY.md`，加上 `docs/adr/`。见 `docs/agents/domain.md`。
