# SeekCloud

基于 DeepSeek 的云端编程 Agent 服务，独立第三方，体验对标 Claude Code 网页版。英文名 SeekCloud；本仓库也可以用中文名"云上求索"（2026-11-14 用户定的），标志和配色见 `docs/brand/README.md`。

这是 SeekCloud 付费版的开源、自部署主干版本：只有一个管理员账户，自己部署自己用，不加多用户（2026-11-12 用户定的）。公开的文档、工单和提交里，关于付费版只说"本仓库是付费版的开源、自部署主干版本"这一句，不写别的（2026-11-14 用户定的）。

## 先读这些

- `GLOSSARY.md`：领域术语。写文档、写代码、和用户沟通都用这里的叫法。
- `docs/adr/`：改起来代价大的决定，并写明了理由。
- `docs/roadmap/2026-11-08-handoff.md`：路线图的交接，包括已定的决定、要从收费版搬过来的工单和开工前要做的事。写规格、拆工单之前先读。

## 当前进度

- 代码从 SeekCloud 收费版迁移而来，已经去掉计费、改成单管理员（ADR 0008）、改了 Agent 的叫法（ADR 0004）、写好了 README，许可证改成了 AGPL-3.0（ADR 0009）。
- Agent 执行尚未实现：宿主机连得上主站了（#91），但还不能建沙箱（#18 等测试机）。没有宿主机连着时新会话停在排队；连着时新会话以"无法创建沙箱"失败。
- 路线图 2026-11-08 定了，见交接文档 `docs/roadmap/2026-11-08-handoff.md`。
- 核心功能的规格和工单拆完了（2026-11-11）：规格是 issue [#13](https://github.com/bilixuesheng/SeekCloud/issues/13)，工单 #14–#56 都是它的子 issue，正文第一行写着被哪些工单阻塞。读工单时正文和评论一起读。
  - #14（测试机）要用户本人做。等它的只有 #18（Sysbox 沙箱）和要真沙箱的验收；连接和协议拆到了 #91，模型网关（#26）、适配接口（#25）不用等测试机（2026-11-15 改的）。#15 已完成：用户 2026-11-13 重建了公开仓库 `bilixuesheng/seekcloud-dsh`（只有一个 README），云端会话能推送。
  - 已完成：#16（会话页动效核对）、#19（顶栏、标题菜单和会话信息）、#20（模型和思考强度的弹层）。#31 的主站这一半也做了：逐字输出（宿主机发来的 `delta`、`progress` 只推送不落库，界面按舒服的速度一个个字显示）；Agent 工作时输入框空着是停止键、有字是 ↵（插进当前回合），⌄ 里有稍后排队和停止；接口是 `POST /api/sessions/{id}/messages` 的 `mode`（`now` 插进当前回合）和 `POST /api/sessions/{id}/stop`（回合马上记成已停止，再给宿主机发 `stop_turn`）。#31 还没做的：幂等 ID、Playwright 冒烟测试，以及宿主机那一半（把消息送进正在跑的 dsh 回合、停下回合，等 #91 和 #25）。
  - #17 的基线配置做了（PR #143，`apps/host/sandbox/dsh/baseline.patch.yml`，用 dsh 0.2.2-rc.3 验过）。#17 剩下的：`seekcloud-dsh` 子模块、技能和 Claude Code 兼容、通用镜像、开源声明、ADR 0004。
  - #91（宿主机连接和协议）做了：WebSocket 连接、宿主机密钥、序号和补发、版本核对、宿主机凭据、断线超时（设置的"会话"一类）。
  - #26（模型网关）做了：主站的 `/api/gateway/v1/messages`（宿主机凭据加会话 ID 认证，剥字段，流式逐个事件转发，报错只给说明、状态码和参考号）、Files 接口（每个会话只碰得到自己传的）、联网搜索（`/v1/tools/search`）和网页抓取（`/v1/tools/fetch`，主站替沙箱去取，转成 Markdown；不连内网和本机地址，不跟重定向；照 Claude 不受网络策略约束，2026-11-18 用户定的），联网工具按次数记用量，用量记录，三个扩展点，设置的"模型"一类填 DeepSeek key，没填 key 时发起会话报错；宿主机这边的转发（沙箱发到 Git 代理端口的 `/v1/…`，宿主机核对会话临时令牌后带上宿主机凭据转给主站）。#26 做完了。
  - 现在就能开工的：#17 剩下的部分。
  - 要人做的工单打 `ready-for-human` 标签：#14、#121、#126。
- AI 标识两个开关的规格和工单也拆了：规格 [#57](https://github.com/bilixuesheng/SeekCloud/issues/57)，工单 #58（已完成）、#59。八项新功能里只有这一项没有待定的事，所以先写了。
- 2026-11-11 做了一次复查，记在 `docs/roadmap/2026-11-11-review.md`：界面上查出来并改掉的问题、路线图没覆盖到的地方（待定的每条都有建议）、安全排查的结论。写新功能的规格之前先读它。文档里待定的几条 2026-11-14 都定了，结论写在每条后面，写规格时照着做。
- 2026-11-15 做了一次项目审查，记在 `docs/roadmap/2026-11-15-review.md`：查出来并改掉的问题、决定之间对不上的地方、工单阻塞关系的调整、设计上的坑、要用户定的 14 条（每条先写 Claude Code 网页版怎么做，再给建议）。实现工单之前先读它；工单的正文和 2026-11-15 的评论一起读。
- 下游版本怎么接进主干定了：ADR 0010（主干不分叉，下游只在扩展点上接入；主干里不放下游的实现和版本开关）。写模型网关、调度、设置、登录相关的代码时照它做。扩展点的第一步做完了：#89（服务端的身份来源、设置规则，PR #145）和 #90（浏览器端的注册表）。设置里多了"数据"一类，导出数据从"账户"挪了过去。
- 新功能的规格和工单都拆了（2026-11-15）：

  | 规格 | 工单 |
  |---|---|
  | #88 扩展点（ADR 0010） | #89、#90 |
  | #93 部署向导、备份和登录安全 | #94–#100 |
  | #101 多渠道通知 | #102–#106 |
  | #107 检查更新和一键更新 | #108–#111 |
  | #112 多提供方、余额和用量上限 | #113–#116 |
  | #117 Windows 支持 | #118–#121 |
  | #122 安卓 App | #123–#126 |
  | #127 Agent 模式、轨迹视图和插件市场 | #128–#133 |
  | #134 英文界面 | #135–#137 |
  | #138 会话状态细分：等你输入和已完成 | #139、#140 |

- 审查文档第六节的 14 条 2026-11-18 都定了，结论写在每条最后，相关的工单加了评论。要点：网页抓取照 Claude 不受网络策略约束；等回答的会话照常休眠、回答时唤醒接着跑；会话链接单独一个开关、默认关；支持 Git LFS（#152）；没登录时 `/api/health` 不给版本号；安装脚本测公开的镜像站选最快的拉；安卓做原生 App（Kotlin + Jetpack Compose + Material 3，底栏的液态玻璃用 Apache-2.0 的 AndroidLiquidGlass 自己写，不借 DSH Go 的代码，通知是 App 直接弹、可选常驻），#122 要照这个重写；中文界面处处用"云上求索"；侧栏的分组和拖动照 Claude（#153）。安卓的包名用用户自己的域名，域名还没给。
- **接下来**：
  1. 照 2026-11-18 的结论重写安卓规格 #122 和它的工单（#123–#126）。
  2. 实现不等测试机、也不等别的工单的：#17 剩下的部分（基线配置已做）、#153（侧栏的分组和拖动）、#94（发布包和安装脚本）、#100（两步验证）、#135（文案目录）、#139（等你输入的规则版）。#59 里 git 钩子的那一项做了（钩子读沙箱里的 `/etc/seekcloud/commit-trailer`，宿主机写它的那一半跟着 #18 建沙箱时做）。#17 做完接 #25（适配接口）。宿主机的 Sysbox 部分（#18）等 #14 的测试机。
  3. 下面是各项新功能定过的要点，规格里都写了，留在这里备查：
  - 网页图形化部署：Linux 一条命令、Windows 一条 PowerShell 命令，其余在网页向导里完成；
  - 多渠道通知：SMTP 邮件、PWA 推送、飞书/钉钉/企业微信机器人、通用 Webhook；
  - 主站和沙箱宿主机都能装在 Windows 上（通过 WSL2，宿主机也可以用 Hyper-V 虚拟机）；
  - 安卓 App：第一次打开时点"连接服务器"，输入服务器地址；
  - 在设置里一键检查更新、一键安装更新：按本仓库在 GitHub 上发的版本（Releases）更新；尽量无缝，正在运行的沙箱和回合不中断（2026-11-14 用户要求）；
  - 模型网关可以添加多个提供方，并显示 DeepSeek 账户的余额；出错时不自动换提供方，原始报错透明地显示给管理员（ADR 0007 的 2026-11-14 修订）；
  - 在 SeekCloud 界面里重做 dsh 网页版才有的功能：四种 Agent 模式（标准、PTC、极简、创造）、轨迹视图和插件市场（插件中心打开，开源版可以自己添加插件市场，2026-11-14 定的）；
  - Agent 在 GitHub 上的 AI 标识（issue、PR 和评论的署名，以及提交尾注）默认加上，可以在设置里分别关掉；
  - 英文界面（2026-11-14 定的）：界面文案分中英两份，按浏览器语言选，设置里能改；
  - 侧栏照 Claude 的 App（2026-11-14 用户看预览时提的）：会话"⋯"菜单里的置顶、标为未读、移到分组，拖动排序。"⋯"菜单、**置顶**和**标为未读**已经做了（置顶的在侧栏最上面一组，后置顶的在前，归档时自动取消，PR #79；回合在你没看着时结束或失败，侧栏亮蓝点，打开就消掉，`sessions.unread`）。分组和拖动的细节 2026-11-18 定了，写在 #153；
  - 消息置顶（照 Claude，2026-11-15 用户录的视频）：**已经做了**（`message_pins` 表、`/api/sessions/{id}/pins`）。回合最后那条回复下面有图钉，点了这条回复上方展开一行加粗的短标题（生成时先显示占位的闪烁条，不照搬 Claude 闪一下上一条回复的毛病），对话左上角出现几道短横，点开是"会话开头"和每条置顶的标题，点哪个就滚到哪条。短标题现在按规则取（`server/sessions/pin-title.ts`：第一个小标题，没有就用第一句够长的话），**模型网关接上以后换成调一次便宜的模型生成**，用量照常记；
  - 会话状态照 Claude 细分（2026-11-14 用户定的，照下面的建议做）：回合结束以后分"等你输入"和"已完成"，侧栏每个会话右边用图标区分（运行中、等你输入、有新内容、失败）。Claude Code 的会话分进行中、等待输入、可查看结果、已完成、失败五类，怎么判断的没有公开。建议：回合停在选择题、批准、计划这类卡片上时一定算"等你输入"；只有文字时，回合结束后用一次很便宜的模型调用（不思考）判断最后一条消息是不是在等你回答。这次调用和标题生成这类平台自己发起的模型调用一样，都记进用量。另外照 Claude：首页（新会话页）中间、输入框上面的空白处，有等你输入的会话时显示提示，点了跳到那个会话（2026-11-14 用户截图）。

用户在新会话里说"继续"或者"接着做"时，就从"接下来"开始。每完成一个阶段，更新这一节。

## 开发命令

- 结构：`apps/site`（主站：Hono 接口 + React PWA）、`apps/host`（宿主机守护进程）、`packages/protocol`（共享协议包）。
- 在仓库根目录运行：`pnpm typecheck`、`pnpm lint`（Biome；`pnpm format` 自动修）、`pnpm test`、`pnpm build`。CI 跑的就是这四个。
- 测试要一个 PostgreSQL，默认连 `postgres://postgres:postgres@localhost:5432/postgres`，可以用 `TEST_DATABASE_URL` 改。云端会话里先运行 `service postgresql start`，再用 `runuser -u postgres -- psql -c "ALTER USER postgres PASSWORD 'postgres';"` 设好密码。
- GitHub 的调用全部经过 `apps/site/src/server/github/port.ts` 的接口；测试里是 `t.github`（`src/testing/fake-github.ts`，内存里的假 GitHub）。
- 登录：只有一个管理员账户，只用密码登录（ADR 0008）。设置、登录、改密码、重置在 `apps/site/src/server/auth/admin.ts`，登录的接口在 `auth/admin-routes.ts`，密码只存 scrypt 哈希（`auth/password.ts`）；同一个 IP 一小时输错 10 次就暂停。GitHub 不是登录方式，只在设置里关联（`src/server/github/link.ts`）。
- 扩展点（ADR 0010）：`AppDeps` 里的 `identity`（身份来源）和 `settingsPolicy`（设置的读写规则），接口在 `apps/site/src/server/ports.ts`，主干的实现是 `auth/admin-identity.ts` 的 `adminIdentity` 和 `settings.ts` 的 `adminSettings`，在 `main.ts` 里组装。接口里判断是谁一律用 `deps.identity.currentUser(c)`，不直接用 `auth/login-sessions.ts`；设置一律用 `settings.ts` 的 `readSetting`、`writeSetting`，加一项设置就在 `SETTINGS` 里加一行。`extension-rules.test.ts` 读源码守住这几条。下游只从包的出口拿东西：`@seekcloud/site/server`（`src/server/index.ts`）和 `@seekcloud/site/testing`（`src/testing/index.ts`）；下游的表放自己的迁移目录，用 `runMigrations(db, [{ folder, table }])`。
- 浏览器端的扩展点（ADR 0010）在 `apps/site/src/client/registry.tsx`：页面（地址样式、组件、要不要登录、是不是盖在页面上的弹窗）、设置分类（加一类只登记一项，`order` 排顺序）、四个插槽（`sidebar-foot`、`composer-below`、`session-banner`、`home-below-greeting`，页面上用 `<Slot name="..." />`）。主干自己的在 `client/trunk.tsx` 登记，`main.tsx` 只做登记和挂载（`mountApp`）；登录后的页面从 `useShell()`（`client/shell.tsx`）拿管理员、会话列表这些。路由（`router.ts`）查这张表，找不到的地址回首页。下游从 `@seekcloud/site/client`（`src/client/index.ts`）拿。
- 加了路径里带某个人的数据 ID 的接口（`/api/sessions/{shortId}/...` 这类），要在 `server/isolation.test.ts` 的清单里加一行，漏了测试就失败：它用测试替身 `FakeIdentity`（`src/testing/fake-identity.ts`）放进第二个人，拿对方的 ID 调每个接口。身份来源的契约测试在 `src/testing/identity-contract.ts`，最小下游样例在 `src/testing/downstream-example/`（起一个真的 HTTP 服务）。
- 宿主机连接（#91）：守护进程用宿主机密钥主动连主站的 WebSocket（`/api/hosts/connect`）。握手、帧、序号和补发、协议版本的规矩在 `packages/protocol/src/link.ts` 和 `index.ts` 的 `PROTOCOL_VERSION` 注释（加命令、事件不升版本；相差一个版本要能互通）。主站这边是 `apps/site/src/server/hosts/`：`hub.ts` 的 `HostHub`（真的 `HostLink`，管多台宿主机，`sessions.host_id` 记会话在哪台，宿主机只能上报自己名下的会话，断线超过设置 `host_offline_grace` 的时长把运行中的会话标为失败）、`keys.ts`（密钥只存哈希）、`credential.ts`（宿主机凭据的中间件 `hostAuth`，模型网关这些路由挂上它）、`frames.ts`（宿主机发来的帧逐个校验）。添加、吊销宿主机：在 `apps/site` 里 `DATABASE_URL=... pnpm host:create <名字>`、`pnpm host:revoke <名字>`。守护进程这边是 `apps/host/src/site-link/`（`SiteLink` 断线自动重连，`commands.ts` 把命令接进 Git 代理的会话表；沙箱相关的先回"建不了沙箱"），环境变量 `SEEKCLOUD_SITE_URL`、`SEEKCLOUD_HOST_KEY`。测试：主站用 `createTestApp({ hosts: true })` 起真的 HTTP 服务，`src/testing/host-client.ts` 的 `TestHostClient` 扮演守护进程（`t.hub.tick()` 跑定时检查）；守护进程的测试里扮演主站（`site-link.test.ts`）。其余测试照旧用假宿主机 `t.host`。
- 模型网关（#26）在 `apps/site/src/server/gateway/`：`gateway.ts` 的 `ModelGateway`（Messages 的转发、流式改写、用量；`complete()` 是平台自己发起的模型调用的内部入口，起标题、置顶短标题、判断是否在等输入都走它）、`files.ts`（Files 接口：文件转给提供方存，`model_files` 记是哪个会话传的，列表、删除、Messages 里引用都只认本会话的）、`web.ts`（联网搜索，DeepSeek 搜索接口的格式，结果只留几个字段）、`fetch.ts` 和 `html.ts`（网页抓取：主站自己去取，网页转成 Markdown，嵌套太深的先线性地估出来、改用纯文本提取）、`upstream.ts`（Files、搜索这类不分模型的接口往上游发请求）、`failures.ts`（上游出错时记原始报错、给调用方的说明和参考号）、`trunk.ts`（三个扩展点的主干实现：`usageAdmission` 记用量、`deepseekRouting` 只有 DeepSeek 官方一个提供方（`route()` 按模型，`service()` 给 Files 和联网搜索）、`transparentErrors` 对管理员透明；提供方的 key 存在 `model_providers`，用 `SEEKCLOUD_SECRET_KEY` 加密）。接口是 `routes/gateway.ts`（`/api/gateway/v1/messages`、`/v1/files…`、`/v1/tools/search`、`/v1/tools/fetch`，调用方只有宿主机，带宿主机凭据和 `X-SeekCloud-Session`；不过同站检查，因为不看 Cookie）和 `routes/model.ts`（设置里的 key、按参考号查上游原始报错 `/api/model-errors/{ref}`）。模型用量在 `model_usage`，联网工具的次数在 `web_tool_usage`，上游原始报错在 `upstream_errors`（保存 30 天）。测试里 `t.model`（`src/testing/fake-model.ts`）是假的提供方（Files 真的存在内存里），`src/testing/gateway-client.ts` 的 `gatewayRequest` 扮演宿主机调网关，`createTestApp()` 默认填好了一个假 key，`createTestApp({ modelKey: false })` 是还没填；三个扩展点的契约测试在 `src/testing/model-contracts.ts`。主站去连外面的地址（抓取，以后的自接 MCP、插件索引）一律经过 `server/network/address.ts`（按解析后的 IP 判断，不连内网、本机和元数据地址）；网络策略的域名匹配和默认清单在 `server/network/policy.ts`（给 #47 的出站代理用；抓取不受网络策略约束）。抓取的测试把假网站开在 127.0.0.2 上，用 `createTestApp({ outboundNetwork })` 换掉域名解析。宿主机这一半在 `apps/host/src/model-gateway/forward.ts`：Git 代理端口上的 `/v1/…` 核对会话临时令牌后转给主站（dsh 怎么配见 `apps/host/sandbox/README.md` 的"模型网关"）。
- 主站和宿主机之间的消息定义在 `packages/protocol`。主站通过 `apps/site/src/server/sessions/host.ts` 的 `HostLink` 和宿主机通信；测试里是 `t.host`（`src/testing/fake-host.ts`，按脚本回放 Agent 事件，`manual = true` 时由测试自己 `emit`）。会话编排在 `src/server/sessions/sessions.ts`。
- 宿主机（`apps/host`）：GitHub 工具服务（MCP，`/mcp`）在 `src/github-tools/`，测试接假的 GitHub API；dsh 怎么接见 `apps/host/sandbox/README.md`。Git 代理在 `src/git-proxy/`，提交签名在 `src/signing/`，沙箱里要装的签名助手和 git 配置在 `apps/host/sandbox/`。测试用真的 `git`（`git http-backend` 当假 GitHub）、`openssl` 和 `ssh-keygen`，云端会话里先运行 `apt-get install -y openssh-client`。生成签名密钥：`pnpm --filter @seekcloud/host signing-key <私钥路径>`，打印出来的公钥加到 SeekCloud 账号的 GitHub 签名密钥里。dsh 的基线配置（`apps/host/sandbox/dsh/baseline.patch.yml`）的测试在普通 CI 里只查文件；要用真的 dsh 验，在一个临时目录里用 Node 24.9 以上运行 `npm i @deepseek-ai/dsh@0.2.2-rc.3`，再设 `SEEKCLOUD_DSH_BIN=<临时目录>/node_modules/.bin/dsh` 跑宿主机的测试（PATH 里的 node 也要是 24.9 以上）。宿主机的环境变量：`SEEKCLOUD_SITE_URL`（主站对外的地址）、`SEEKCLOUD_HOST_KEY`（宿主机密钥）、`SEEKCLOUD_VERSION`、`SEEKCLOUD_SIGNING_KEY`（签名私钥路径）、`SEEKCLOUD_SIGNER_EMAIL`（SeekCloud 账号的邮箱）、`SEEKCLOUD_GIT_PROXY_HOST`、`SEEKCLOUD_GIT_PROXY_PORT`、`SEEKCLOUD_HOST_DATA`。
- SSE 接口用 `browser.stream(path)` 测（`src/testing/event-stream.ts`），用完要 `close()`。`t.admin()` 得到一个已登录的管理员浏览器（第一次调用时用 `t.adminPassword` 设置密码，每次调用都是一台新设备）；`t.adminWithGitHub(login, ...仓库)` 再关联 GitHub、装好 App，再调用一次会换成新的 GitHub 账号。
- 主站的测试用 `apps/site/src/testing/test-app.ts` 的 `createTestApp()`：进程内调用接口，每调用一次建一个独立的库（一般一个测试文件一次），时钟是假的。`t.browser()` 模拟一个有自己 Cookie 和 IP 的浏览器，`browser.clone()` 复制一份带着同样 Cookie 的。`createTestApp({ identity, settingsPolicy })` 换掉扩展点；换了身份来源以后用 `t.linkGitHub(浏览器, login, ...仓库)` 给已登录的浏览器关联 GitHub。
- 主站的每个响应都带内容安全策略（`apps/site/src/server/app.ts`）：脚本只能来自本站，页面里不能写内联脚本，要在页面画出来之前跑的放进 `apps/site/public/` 下单独的文件（比如 `theme-boot.js`）。接口的请求体最多 1 MB（webhook 25 MB）。
- Agent 回复里的图片只有 GitHub 和主站自己的直接显示，别的来源点了才加载（`session/Markdown.tsx` 的 `trustedImageHost`）：图片地址是 Agent 写的，直接加载等于给了它一条往外送数据的路。
- 要看界面时，可以用假 GitHub、假宿主机起一个真主站来截图：照 `apps/site/src/testing/test-app.ts` 的写法建 `createApp()`，再挂上 `dist/client` 的静态文件。
- 接口出错时统一返回 `{ error: { code, message } }`：`code` 给程序判断，`message` 是给人看的中文。用 `apps/site/src/server/errors.ts` 的 `apiError()`。
- 全站设置（管理员在设置窗口里改的配置）存在 `settings` 表里，一项一行，读写都走 `apps/site/src/server/settings.ts`；接口在 `routes/settings.ts`（`/api/settings/...`）。现在有 AI 标识的两个开关（随准备沙箱的命令下发给宿主机，改了以后给沙箱还开着的会话再发一次 `set_ai_labels`）和新会话默认的思考强度（`/api/models` 的 `defaultEffort` 也是它，发起会话时没指定思考强度就用它）。
- 加表：改 `apps/site/src/server/db/schema.ts`，然后在 `apps/site` 里运行 `pnpm db:generate --name <名字>` 生成迁移。主站启动时自动跑迁移。
- 后台的定期任务在 `apps/site/src/server/maintenance.ts`：打包数据导出、删过期的导出、删满 180 天的访问记录。main.ts 每分钟跑一次；测试里调用 `t.runMaintenance()`，导出的压缩包写在 `t.dataDir`（临时目录）。
- 主站的环境变量：`SEEKCLOUD_DATA_DIR`（主站的数据目录，导出的压缩包放这里，默认 `./data`，要放在会备份的磁盘上）、`DATABASE_URL`、`PORT`（默认 3000）、`SEEKCLOUD_VERSION`、`NODE_ENV=production`（登录 Cookie 只走 HTTPS）、`SEEKCLOUD_SECRET_KEY`（加密令牌用的 32 字节密钥，base64，用 `openssl rand -base64 32` 生成）、`PUBLIC_URL`（主站对外的地址）、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_APP_SLUG`、`GITHUB_WEBHOOK_SECRET`（没配 GitHub 时，GitHub 相关功能直接报错）。部署时只有一层反向代理，它把客户端地址追加到 `X-Forwarded-For` 末尾；频率限制只认最后一个值。
- 许可证是 AGPL-3.0，加了署名附加条款（ADR 0009，条款原文在 `NOTICE`）。不要拷贝许可证和 AGPL-3.0 不兼容的代码。
- 主站和宿主机的运行时依赖只用宽松的许可证（MIT、Apache-2.0、BSD、ISC 这类，`licenses.ts` 的类型里列着现在允许的几种）。别人的 GPL、AGPL 代码不进主站、宿主机和安卓 App：`CONTRIBUTING.md` 的再授权声明要成立，整个程序里就不能有作者没法另行授权的代码。DSH Go（AGPL-3.0）的代码也不借，安卓 App 只参考它的做法（2026-11-18 用户定的）。
- 加了运行时依赖，要在 `apps/site/src/client/legal/licenses.ts` 的开源声明里补上，有测试检查。开源声明页开头 SeekCloud 自己的署名（`legal/LegalPage.tsx`）不能删，这是附加条款要求的。
- 忘记管理员密码：在 `apps/site` 里运行 `DATABASE_URL=... pnpm admin:reset-password`，打印一个随机的新密码，所有设备退出登录。
- 访问记录（登录、发起会话、发消息时的 IP）在 `apps/site/src/server/access-log.ts`，保存 180 天。
- README 有中英两份（`README.md`、`README.en.md`），改的时候两份一起改。
- 提交信息按"类型: 说明"写：类型按改动性质选（feat、fix、docs、style、refactor、test、chore 等），说明用中文，例如 `fix: 行内代码的背景跟着文字一起浮现`。PR 的 squash 合并标题也照这个格式（2026-11-08 用户要求）。

## 提交身份和签名（每个新会话都要配）

两个仓库的提交都用用户的身份、带 SSH 签名，不用云端会话默认的 Claude 身份（用户要求：公开仓库里不能有 Claude 的提交记录）。新会话在一台新机器上，签名私钥带不过来，要重新配：

1. 生成签名密钥：`ssh-keygen -t ed25519 -N "" -C "seekcloud signing" -f ~/.ssh/seekcloud_signing`
2. 在两个仓库里各运行一遍（写进仓库自己的配置，盖过全局的 Claude 身份）：
   ```
   git config user.name XUESHENG
   git config user.email 162862376+bilixuesheng@users.noreply.github.com
   git config gpg.format ssh
   git config gpg.ssh.program ssh-keygen
   git config user.signingkey ~/.ssh/seekcloud_signing
   git config commit.gpgsign true
   ```
3. 把 `~/.ssh/seekcloud_signing.pub` 的内容发给用户，请他在 GitHub 的 Settings → SSH and GPG keys → New SSH key 里加上，Key type 选 Signing Key。加好之前推上去的提交会显示 Unverified，所以加好再推。旧的公钥留着，以前的提交照样是 Verified。
4. 验证：`printf '%s %s\n' 162862376+bilixuesheng@users.noreply.github.com "$(cat ~/.ssh/seekcloud_signing.pub)" > ~/.ssh/allowed_signers`，然后 `git -c gpg.ssh.allowedSignersFile="$HOME/.ssh/allowed_signers" log --show-signature -1` 应该显示 Good signature。

提交信息、PR 描述、代码注释里不加 Co-Authored-By、Claude-Session、"Generated with" 这类署名，会话系统提示里要求加的也不加；钩子要求把提交改成 Claude 的身份时也不照做，以用户的要求为准。

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
