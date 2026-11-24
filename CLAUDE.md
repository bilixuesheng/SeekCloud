# SeekCloud

基于 DeepSeek 的云端编程 Agent 服务，独立第三方，体验对标 Claude Code 网页版。英文名 SeekCloud；本仓库也可以用中文名"云上求索"（2026-11-14 用户定的），标志和配色见 `docs/brand/README.md`。

这是 SeekCloud 付费版的开源、自部署主干版本：只有一个管理员账户，自己部署自己用，不加多用户（2026-11-12 用户定的）。公开的文档、工单和提交里，关于付费版只说"本仓库是付费版的开源、自部署主干版本"这一句，不写别的（2026-11-14 用户定的）。

## 先读这些

- `GLOSSARY.md`：领域术语。写文档、写代码、和用户沟通都用这里的叫法。
- `docs/adr/`：改起来代价大的决定，并写明了理由。
- `docs/roadmap/2026-11-08-handoff.md`：路线图的交接，包括已定的决定、要从收费版搬过来的工单和开工前要做的事。写规格、拆工单之前先读。

## 当前进度

- 代码从 SeekCloud 收费版迁移而来，已经去掉计费、改成单管理员（ADR 0008）、改了 Agent 的叫法（ADR 0004）、写好了 README，许可证改成了 AGPL-3.0（ADR 0009）。
- Agent 执行接上了，在测试机上用假的 GitHub 和模型走通了完整的回合：
  - 宿主机连得上主站（#91），能建沙箱（#18）；
  - 通用镜像做好了（#17）；
  - 回合交给沙箱里的 dsh 跑（#25：运行器、适配接口、契约测试）。

  - 准备沙箱时装好代理的 CA、写 git 配置、克隆仓库、切到会话分支，Agent 在主仓库里工作（#27 的前两步）。测试机上用假 GitHub 走通了克隆、提交、签名、推送。

  - 回合结束时宿主机补提交、推送会话分支，发 `workspace` 事件（检查点、推送结果、这一回合改了的文件），主站记下、推送失败自动跟进（最多 2 次），界面上有改动卡片（#27 的第三步）。

  - 改动面板：宿主机回合结束后算会话分支对比基础分支的 diff（`workspace.diff` 事件），主站每个仓库只存最新的一份（`workspace_diffs` 表，`GET /api/sessions/{id}/diff`），界面上点改动卡片的"查看全部"或文件名打开（`client/session/ChangesPanel.tsx`）。

  - dsh 的会话文件：回合结束时宿主机把沙箱里 `$DSH_HOME/sessions` 打包发给主站（`agent.archive` 事件），主站存在 `SEEKCLOUD_DATA_DIR/agent-sessions/<会话>.tar.gz`，删会话时一起删；准备沙箱时带回去（`prepare_sandbox.agentArchive`），沙箱是新建的（被回收过）时宿主机放回去，Agent 接着原来的对话（`server/sessions/agent-archive.ts`，`SandboxAgents.restore`）。

  - 测试机上用真的主站、真的宿主机连接、真沙箱和 dsh 走通了一个完整的回合（`apps/host/src/e2e.sysbox.test.ts`，只有 GitHub 和模型是假的，`sandbox.yml` 起一个 PostgreSQL 容器）。#27 的代码做完了；剩下要真机验的：真的 GitHub 仓库、真的 DeepSeek、签名在 GitHub 上显示 Verified（要把宿主机的签名公钥加到账号上）。

  没有宿主机连着时，新会话停在排队；连着的宿主机没配沙箱镜像时，新会话以"无法创建沙箱"失败。
- 路线图 2026-11-08 定了，见交接文档 `docs/roadmap/2026-11-08-handoff.md`。
- 核心功能的规格和工单拆完了（2026-11-11）：规格是 issue [#13](https://github.com/bilixuesheng/SeekCloud/issues/13)，工单 #14–#56 都是它的子 issue，正文第一行写着被哪些工单阻塞。读工单时正文和评论一起读。
  - #14（测试机）2026-11-18 做完了：香港的 4 核 4 GB KVM 云服务器，Ubuntu 24.04，装好 Docker 29 和 Sysbox 0.7.1，注册成本仓库的自托管 Runner（标签 `sysbox`），`.github/workflows/sandbox.yml` 的冒烟测试在上面跑通了。原来等它的是 #18（Sysbox 沙箱）和要真沙箱的验收；连接和协议拆到了 #91，模型网关（#26）、适配接口（#25）不用等测试机（2026-11-15 改的）。#15 已完成：用户 2026-11-13 重建了公开仓库 `bilixuesheng/seekcloud-dsh`（只有一个 README），云端会话能推送。
  - 已完成：#16（会话页动效核对）、#19（顶栏、标题菜单和会话信息）、#20（模型和思考强度的弹层）。#31 的主站这一半也做了：逐字输出（宿主机发来的 `delta`、`progress` 只推送不落库，界面按舒服的速度一个个字显示）；Agent 工作时输入框空着是停止键、有字是 ↵（插进当前回合），⌄ 里有稍后排队和停止；接口是 `POST /api/sessions/{id}/messages` 的 `mode`（`now` 插进当前回合）和 `POST /api/sessions/{id}/stop`（回合马上记成已停止，再给宿主机发 `stop_turn`）。#31 还没做的：幂等 ID、Playwright 冒烟测试，以及宿主机那一半（把消息送进正在跑的 dsh 回合、停下回合，等 #91 和 #25）。
  - #17 的基线配置做了（PR #143，`apps/host/sandbox/dsh/baseline.patch.yml`，用 dsh 0.2.2-rc.3 验过）。通用镜像做了（`apps/host/sandbox/image/`，测试机上构建、用 Sysbox 跑自检通过，`.github/workflows/sandbox-image.yml`）。技能和 Claude Code 兼容做了：不 fork dsh，自己写了一个 dsh 插件（`apps/host/sandbox/dsh/claude-code-skills.js`，由基线配置插进去），读 `.claude/skills` 和 `.claude/commands`，用真的 dsh 加假模型验过；改 dsh 的方式写进了 ADR 0004（装官方 npm 包，版本钉在 `apps/host/sandbox/dsh/VERSION`，配置和自己的插件做不到的才去 `seekcloud-dsh` 改源码）。#17 做完了。
  - #91（宿主机连接和协议）做了：WebSocket 连接、宿主机密钥、序号和补发、版本核对、宿主机凭据、断线超时（设置的"会话"一类）。
  - #18（宿主机守护进程和 Sysbox 沙箱）的沙箱部分做了，在测试机上验过：建、启、停、删，守护进程重启后认回；沙箱里能跑 Docker；CPU、内存上限；沙箱之间不通、连不上宿主机别的端口；在沙箱里跑命令（参数数组、超时杀进程树）；内存用满时先杀构建进程、不杀 Agent；写 AI 标识的开关；上报开着的沙箱数。单个沙箱的磁盘配额在 ext4 加 Sysbox 上做不到，现在靠磁盘超过 80% 时回收兜着（ADR 0005）。2026-11-19 用户问能不能完全限住，改用 XFS 项目配额做，工单是 #168。命令时长挪到 #25。还没做的：守护进程重启后由主站重发会话的登记信息（#111）。
  - #26（模型网关）做了：主站的 `/api/gateway/v1/messages`（宿主机凭据加会话 ID 认证，剥字段，流式逐个事件转发，报错只给说明、状态码和参考号）、Files 接口（每个会话只碰得到自己传的）、联网搜索（`/v1/tools/search`）和网页抓取（`/v1/tools/fetch`，主站替沙箱去取，转成 Markdown；不连内网和本机地址，不跟重定向；照 Claude 不受网络策略约束，2026-11-18 用户定的），联网工具按次数记用量，用量记录，三个扩展点，设置的"模型"一类填 DeepSeek key，没填 key 时发起会话报错；宿主机这边的转发（沙箱发到 Git 代理端口的 `/v1/…`，宿主机核对会话临时令牌后带上宿主机凭据转给主站）。#26 做完了。
  - #25（Agent 适配接口）2026-11-18 做了大部分（PR #161、#162），剩下的写在 #25 的最后一条评论里：选择题和批准的卡片、命令时长、守护进程重启不打断回合（#111）。工作目录指到主仓库（#27 做了）、沙箱回收后 dsh 会话日志的去处（#27 的会话文件复制做了）。
  - #27（第一条真实闭环）的代码做完了（PR #166、#167、#170–#173），等真机验收。
  - 要人做的工单打 `ready-for-human` 标签：#121、#126（安卓的发布密钥，包名、应用名已经定了）。
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
  | #112 多提供方、余额和用量上限 | #113–#116、#188 |
  | #117 Windows 支持 | #118–#121 |
  | #122 安卓 App | #123–#126、#177–#182、#203–#205 |
  | #127 Agent 模式、轨迹视图和插件市场 | #128–#133 |
  | #134 英文界面 | #135–#137 |
  | #138 会话状态细分：等你输入和已完成 | #139、#140 |

- 审查文档第六节的 14 条 2026-11-18 都定了，结论写在每条最后，相关的工单加了评论。要点：网页抓取照 Claude 不受网络策略约束；等回答的会话照常休眠、回答时唤醒接着跑；会话链接单独一个开关、默认关；支持 Git LFS（#152）；没登录时 `/api/health` 不给版本号；安装脚本测公开的镜像站选最快的拉；安卓做原生 App（Kotlin + Jetpack Compose + Material 3，底栏的液态玻璃用 Apache-2.0 的 AndroidLiquidGlass 自己写，不借 DSH Go 的代码，通知是 App 直接弹、可选常驻），#122 要照这个重写；中文界面处处用"云上求索"；侧栏的分组和拖动照 Claude（#153）。安卓的包名是 `cn.seekcloud.app`（用户的域名 seekcloud.cn 倒写，2026-11-18 定的）。
- **接下来**：
  0. 模型和 key 的管理照 dsh 官方的"设置 → 模型"做（2026-11-22 用户定的，只有开源版有；#112 的 2026-11-22 评论）：DeepSeek、dsh 目录里的第三方提供方（`@earendil-works/pi-ai`）、自定义接口（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini 四种协议）、获取可用模型、每个模型的选项、key 只写不读和环境变量。主站一半是 #113（每个提供方一个透明转发，主站换上真正的 key），沙箱一半是 #188（沙箱里的 dsh 用自己的适配器说各家的协议）。先做这个。#113 分三步：第一步（数据和接口，PR #189）做了：提供方和模型的表、目录快照、DeepSeek 发布的列表、key 脱敏、环境变量、`/api/models`、会话记"提供方/模型"、路由按协议放认证头；第二步（PR #190）做了：透明转发、四种协议的用量、平台调用按协议、获取可用模型；第三步（PR #192）做了：照 dsh 的设置页（`client/settings/models/`：提供方卡片、API 密钥输入框、模型目录和模型选项、获取可用模型、添加模型提供商的两个标签）、模型选择器按提供方分组、没有能用的模型时新会话页显示"选择模型"。2026-11-22 用户说模型页粗糙（怎么知道哪个最省、添加模型糙、每个模型的思考档位和参数不一样、上下文窗口的输入反人类），PR #194 重做了两轮：模型列表每行写清能力（上下文、输出、图片、思考档位、价格）；添加模型从目录、接口或输入 ID，认得出来的模型（`server/models/known.ts` 按 ID 在内置目录里找，去前缀、点和连字符不计，取厂商自己的那份）先填好资料，目录快照多记了各档位的参数值（`wire`）；上下文窗口可以写 128K、1M、12.8万（`client/settings/models/tokens.ts`）；思考档位按协议给（`reasoning.ts`：OpenAI 系改参数值、Anthropic 按预算或自适应思考、Gemini 只有四档，主站的 `checkModels` 也按协议核对）；自定义接口的模型可以填价格（`provider_models.cost`）；平台调用的"自动"只看能关闭思考的模型，按一次调用的估价挑最省的（`autoPlatformModel`），设置页写明现在用的是哪个、为什么。#188（沙箱里的 dsh 用这些提供方，也在 PR #192）做了：主站在 `prepare_sandbox.providers`、`set_models` 里下发能用的提供方（不带地址和 key），宿主机写 `/etc/seekcloud/models.patch.yml`（`apps/host/src/agent/models-config.ts`）叠在基线配置前面，`/v1/providers/<id>` 按协议核对会话令牌后转给主站的透明转发；真 dsh 加假的 OpenAI 兼容接口的契约测试过了；测试机的端到端测试也加了一个用自定义提供方（OpenAI 兼容接口）跑的回合。#191（不选仓库也能发起会话）做了：`POST /api/sessions` 的 `repo`、`baseBranch` 可选（要么都给要么都不给），不选仓库时不查 GitHub、没关联也能发起，`session_repos` 没有行；新会话页的仓库按钮默认"不使用仓库"，弹层第一项也是它；这种会话不下发 GitHub 令牌，宿主机不克隆、Agent 在 `/workspace` 里工作、回合结束不提交不推送，GitHub 工具服务的工具列表是空的，Git 代理照 ADR 0003 不放行任何仓库（公开仓库也要先挂载）；会话中途挂载仓库另开工单。#100（登录安全）做了：两步验证（TOTP、恢复码）和通行密钥（WebAuthn），还没做的只有部署向导里"建议开启两步验证"的提示（向导是 #94–#99）。#135（文案目录）做了：文案模块、选语言、设置的"语言"、中英两份 PWA 清单、登录页（含首次设置、两步验证）和设置的"通用"已迁，扫描写死中文的测试带着豁免清单。#136 的第一批做了：新会话页（问候语英文另写一套，猜地区那句只有中文有）、侧栏、会话列表、账户菜单、输入框、模型弹层、会话菜单和会话信息、通用的确认框、弹窗、通知；默认环境的名字改存空的、内置 DeepSeek 模型的说明挪进文案目录（服务端不存现成的中文）；英文的冒烟测试 `i18n/english.browser.test.ts`。#136 的第二批（会话页）做了：时间线的提示、工具调用的摘要（每一类一个整句模板，按语言连成一句：`i18n/format.ts` 的 `joinClauses`）、正在做时的进行时说法（`toolActive`）、Agent 的报错、改动卡片和面板、会话页各处的读屏文字；取不出的置顶短标题改存空的；会话接口的报错码有了英文。#136 的第三批做了：设置的 GitHub、账户（昵称、密码、两步验证、通行密钥、登录设备）、会话、数据导出，开源声明页（附加条款规定的署名"基于 SeekCloud"两种语言下都照原文，英文后面附一句说明）；登录设备名里的浏览器改存英文正式名称；时长的分段选择改成数字在上、单位在下（`minutesParts`，单位按 Intl）。#136 的最后一批（设置的"模型"页，连同模型接口的报错）也做了，#136 做完了，扫描的豁免清单清空了：内置 DeepSeek 的名字改存空的，目录里几个有中文名的提供方（Kimi、智谱、MiniMax 中国、小米）改存英文正式名称，界面按语言换（`settings/models/types.ts` 的 `providerLabel`）。#94（发布包和安装脚本）做了（PR #200）：主站镜像、Compose、一条命令的安装脚本（CI 的 Install 工作流在干净的 Ubuntu 里跑）、反向代理层数的设置、Cookie 的 Secure 按请求定、服务端构建成 JavaScript；本机宿主机的安装是 #97，向导的"网络"一步和域名、HTTPS 是 #96，发布镜像（amd64 和 arm64）是 #108。#123（安卓工程骨架）做了（PR #202），开工前拆成了 #123（骨架和 CI）、#203（接口代码生成）、#204（网络层和"连接服务器"页）、#205（登录、服务器列表、出错页）；#203 也做了。#204 做完了：连接的逻辑（`net/`：地址规整、认 SeekCloud、HTTP 要确认、自签证书按指纹钉住、证书换了重问、http 跳到同主机的 https 时改连 https）和"连接服务器"页（`connect/`：页面、确认弹窗、`ServerStore` 记下连上的主站和放行），文案从主干目录生成；网络层（`net/`）：`serverClient` 带设备令牌（`token`），事件流 `eventStream`（SSE，断线重连带 `Last-Event-ID`，401、403、404 不再重连，读超时 75 秒），报错 `ApiException` 和 `errorText`（认得的 code 用网页目录里的 `error.*`，生成的 `ErrorMessages.kt`）。#205 的第一部分做了：页面怎么走在 `AppFlow.kt`（打开时认主站、看令牌，连不上去出错页，证书换了或要升 https 回"连接服务器"页重新确认，版本太低去要更新页，`/api/me` 回 401 删掉令牌回登录页并说明"此设备已退出登录"；登录和两步验证、退出、换服务器、删服务器、改地址），界面接在 `AppViewModel.kt` 和 `ui/`（登录页、首页（会话列表 #124 做好前只放登录状态）、服务器列表、出错页、要更新页，改地址换了主机先确认"沿用登录状态"）；设备令牌用 Android Keystore 的 AES-GCM 加密存（`auth/TokenStore.kt`），按主站的编号存（`SavedServer.id`，改地址不变）；登录的接口手写在 `auth/AuthApi.kt`（生成的代码认不出 200 和 202 两种成功）；`PrivacyChecksTest` 核对源码里不打日志、备份规则排除所有存储。剩下 CI 里模拟器加假主站的界面测试。思考强度改成了 dsh 的七档（off、minimal、low、medium、high、xhigh、max），每个模型只给自己支持的，滑块上只画这几档。
  1. 安卓的规格 #122 和工单 2026-11-19 照原生 App 重拆好了（#122 的 2026-11-19 评论里有一张表）。主站这边的设备令牌 #177 做了（PR #183），App 的工程骨架 #123 可以开工；云端会话里没有安卓 SDK，要先看能不能装、CI 里怎么构建。
  2. 实现不等测试机、也不等别的工单的：#94（发布包和安装脚本）、#100（两步验证，App 的登录也要走，见 #100 的 2026-11-19 评论）、#135（文案目录）。#153（侧栏的分组和拖动）做了（PR #184、#185），拖动在会话上往右、收侧栏往左，等用户在预览里试过手感再定。#139（等你输入的规则版）、#140（换成模型判断）做了，#140 剩下用真的 DeepSeek 实测误判率。#59 里 git 钩子的那一项做了（钩子读沙箱里的 `/etc/seekcloud/commit-trailer`，宿主机准备沙箱和收到 `set_ai_labels` 时写它，#18 做了）。#17、#18 做完了，#25 做了大部分。接着是 #27（第一条真实闭环）。它要先做三件事：
     - 准备沙箱时克隆仓库（做了）；
     - 照 `apps/host/sandbox/README.md` 配好沙箱里的代理、CA 证书和 git 配置（做了）；
     - 把 Agent 的工作目录指到主仓库（做了）。

     回合结束补提交、推送、跟进、改动卡片、改动面板和会话文件复制也做了，测试机上用真的主站走通了（端到端测试）。#27 剩下真机验收：真的 GitHub 仓库和 DeepSeek。
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
  - 侧栏照 Claude 的 App（2026-11-14 用户看预览时提的）：会话"⋯"菜单里的置顶、标为未读、移到分组，拖动排序。"⋯"菜单、**置顶**和**标为未读**已经做了（置顶的在侧栏最上面一组，后置顶的在前，归档时自动取消，PR #79；回合在你没看着时结束或失败，侧栏亮蓝点，打开就消掉，`sessions.unread`）。分组和拖动的细节 2026-11-18 定了，写在 #153。#153 的第一半做了：分组（`session_groups` 表，`/api/session-groups`）、顺序（`sessions.sort_key`，"最近"里的有新动静时记成当时的毫秒数，置顶和分组里的不动；放置接口 `POST /api/sessions/{id}/place` 取前后两个的中间值，分不开时重新编号，`server/sessions/sidebar.ts`）、置顶和分组互斥、列表事件流的 `groups`、侧栏的分组标题（折叠记在这台设备上，`client/session/sidebar-sections.ts`）和"⋯"（重命名、删除，`GroupMenu.tsx`）、会话菜单的"移到分组"；第二半（拖动和手势）也做了：判定规则在 `client/session/drag-gesture.ts`（手机先判方向，先竖着走是滚动，在会话上先往右横着走是拖动、往左是收起全屏侧栏；电脑按住一动就拖），界面在 `useSidebarDrag.ts`（浮起来的会话、插入线、靠近上下边自己滚、"拖到这里置顶"、底部的"新分组"、"松手取消置顶"，侧栏跟着手指横向动、松手弹回）。整个侧栏和列表都是 `touch-action: pan-y`（滚动的容器里面要再写一遍；不能加 pinch-zoom，不然浏览器会拿横着的滑动去平移）；
  - 消息置顶（照 Claude，2026-11-15 用户录的视频）：**已经做了**（`message_pins` 表、`/api/sessions/{id}/pins`）。回合最后那条回复下面有图钉，点了这条回复上方展开一行加粗的短标题（生成时先显示占位的闪烁条，不照搬 Claude 闪一下上一条回复的毛病），对话左上角出现几道短横，点开是"会话开头"和每条置顶的标题，点哪个就滚到哪条。短标题照 Claude 调一次便宜的模型生成（`server/sessions/pin-title.ts` 的 `PinTitles`，用途 `pin_title`，8 秒超时，在置顶的请求里等它），模型给不出来时按规则取（第一个小标题，没有就用第一句够长的话）；
  - 会话状态照 Claude 细分（规则版 #139 做了：附加说明 `awaiting_input`、`done`，规则在 `server/sessions/awaiting-input.ts`，回合结束后在后台判断，侧栏的"等你输入"图标和首页提示 `client/session/AwaitingInputHint.tsx`；#140 做了：正常结束、有文字时先问模型 `server/sessions/waiting-check.ts`（经 `ModelGateway.text()`，用途 `waiting_check`，不思考、最多 8 个 token、10 秒超时、排队做；用哪个模型是设置的"模型"里的"平台调用的模型" `platform_model`，自动就用 `relativeCost` 最小的），判断不出来退回规则。平台自己发起的调用共用 `server/sessions/platform-call.ts`（选模型、用标记包住 Agent 写的文字、超时、出错返回 undefined）；`createTestApp()` 默认关掉这些调用，测它们时用 `createTestApp({ platformCalls: { timeoutMs } })`）（2026-11-14 用户定的，照下面的建议做）：回合结束以后分"等你输入"和"已完成"，侧栏每个会话右边用图标区分（运行中、等你输入、有新内容、失败）。Claude Code 的会话分进行中、等待输入、可查看结果、已完成、失败五类，怎么判断的没有公开。建议：回合停在选择题、批准、计划这类卡片上时一定算"等你输入"；只有文字时，回合结束后用一次很便宜的模型调用（不思考）判断最后一条消息是不是在等你回答。这次调用和标题生成这类平台自己发起的模型调用一样，都记进用量。另外照 Claude：首页（新会话页）中间、输入框上面的空白处，有等你输入的会话时显示提示，点了跳到那个会话（2026-11-14 用户截图）。

用户在新会话里说"继续"或者"接着做"时，就从"接下来"开始。每完成一个阶段，更新这一节。

## 开发命令

- 结构：`apps/site`（主站：Hono 接口 + React PWA）、`apps/host`（宿主机守护进程）、`packages/protocol`（共享协议包）、`apps/android`（安卓 App，独立的 Gradle 工程）。
- 在仓库根目录运行：`pnpm typecheck`、`pnpm lint`（Biome；`pnpm format` 自动修）、`pnpm test`、`pnpm build`。CI 跑的就是这四个。
- 主站的构建（#94）：`apps/site` 的 `pnpm build` 先构建前端（`dist/client`），再用 `vite.server.config.ts` 把服务端打成普通的 JavaScript（`dist/server`：`main.js` 和命令行工具 `reset-password.js`、`host.js`，迁移和目录快照复制到同一层；node_modules 里的依赖不打进去，工作区的 `@seekcloud/protocol` 打进去）。`pnpm start` 跑 `node dist/server/main.js`；开发时照旧用 `pnpm dev:server`（tsx）。
- 部署（#94）：主站镜像是 `apps/site/Dockerfile`（构建上下文是仓库根目录，`.dockerignore` 在根目录；构建阶段用 bookworm-slim，`pnpm deploy --prod --legacy` 取出生产依赖、删掉只在构建前端时用的字体；运行阶段用 Alpine，node 用户，数据目录 `/data`，健康检查 `/api/health`，`--build-arg VERSION`）。安装脚本是 `scripts/install.sh`（不交互，中英两份提示，`--lang`；Compose 文件和 Caddyfile 写在脚本里生成，只下载这一个文件、核对校验和；主站、PostgreSQL、Caddy 三个容器，数据库只在 `internal` 的 backend 网络里；数据目录默认 `/var/lib/seekcloud`，`site.env`、`postgres.env` 权限 600；重复运行不改已有的密钥；Caddy 先只听 `:80`，域名和证书在向导里配，#96）。Docker 的 apt 源按顺序试官方和几个镜像，签名密钥都核对官方指纹；镜像站的清单在脚本开头，测 `/v2/` 的耗时排好再一个个拉，最后照原名拉一次（管理员自己在 daemon.json 里配的加速生效），拉到后打上原来的名字。CI 的 `.github/workflows/install.yml` 构建镜像，在干净的 `ubuntu:24.04` 容器里跑一遍（只有宿主的 Docker 套接字，脚本要装命令行），再在机器上重跑、改成 `--no-caddy`。本地试：云端会话里能起 dockerd 也能拉镜像，但构建时 npm 要经会话的代理（另做一份带 `/root/.ccr/ca-bundle.crt` 的 Dockerfile，`--network host` 加代理的 build-arg，不提交）。发布镜像时要有 amd64 和 arm64 两种（安装脚本两种都收，#108）。
- 安卓 App（#122、#123）在 `apps/android`：独立的 Gradle 工程（Gradle 9.9.2 包装器，AGP 9.5、Kotlin 2.4 由 AGP 内置、Compose BOM、Material 3；依赖版本在 `gradle/libs.versions.toml`），不进 pnpm 的工作区，根目录的四个检查不管它；CI 是 `.github/workflows/android.yml`（`./gradlew testDebugUnitTest lintDebug assembleDebug`，上传调试版安装包）。minSdk 26，compileSdk 37.2（Compose 要求小版本号 37.1 以上，写法 `compileSdk { version = release(37) { minorApiLevel = 2 } }`），包名 `cn.seekcloud.app`；应用名英文 `values/strings.xml`、中文 `values-zh/strings.xml`；自适应图标的前景和主题图标（鲸鱼剪影）是 `mipmap-*/ic_launcher_*.webp`，从 `docs/brand/whale-on-cloud-source.webp` 生成；不进备份（`allowBackup=false`，`data_extraction_rules.xml`、`backup_rules.xml` 全排除）；只连 HTTPS（`network_security_config.xml`）。接口代码（#203）：主站的 `/api/openapi.json` 去掉 App 不用的接口（`apps/site/src/server/android-api.test.ts` 的 `APP_SKIPS`，每项写明原因：通行密钥、首次设置）存成 `apps/android/api/openapi.json`；App 构建时用 openapi-generator（Gradle 插件，`kotlin` 生成器、`jvm-okhttp4`、kotlinx.serialization）生成到 `app/build/generated/openapi`，不进仓库、不手改，包名 `cn.seekcloud.app.api`（`apis.DefaultApi`、`models.*`）。主站的接口变了要重新导出：在仓库根目录 `pnpm --filter @seekcloud/site openapi:export`，没导出时主站的测试失败。App 的文案写在主站的 `apps/site/src/client/i18n/app-zh.ts`、`app-en.ts`（键就是资源名，`{brand}` 换成品牌名，`{名字}` 按中文里第一次出现的顺序换成 `%1$s`……），`values/strings.xml`（英文，默认）和 `values-zh/strings.xml` 由 `i18n/android.ts` 生成、进仓库、不手改：改了文案在仓库根目录 `pnpm --filter @seekcloud/site android:strings`，没重新生成时主站的测试失败。测试方法名只用英文（Gradle 的测试报告按方法名建文件，系统编码不是 UTF-8 时建不了）。云端会话里构建：先装 SDK（`~/android-sdk`：下 `commandlinetools-linux-*_latest.zip`，`sdkmanager "platforms;android-37.2" "build-tools;37.0.0" "platform-tools"`，`local.properties` 写 `sdk.dir`），Maven Central 经会话代理会回 429，在 `~/.gradle/init.d/` 放一个把它换成 `maven-central.storage-download.googleapis.com/maven2/` 的初始化脚本（不提交）。
- 测试要一个 PostgreSQL，默认连 `postgres://postgres:postgres@localhost:5432/postgres`，可以用 `TEST_DATABASE_URL` 改。云端会话里先运行 `service postgresql start`，再用 `runuser -u postgres -- psql -c "ALTER USER postgres PASSWORD 'postgres';"` 设好密码。
- GitHub 的调用全部经过 `apps/site/src/server/github/port.ts` 的接口；测试里是 `t.github`（`src/testing/fake-github.ts`，内存里的假 GitHub）。
- 登录：只有一个管理员账户，只用密码登录（ADR 0008）。设置、登录、改密码、重置在 `apps/site/src/server/auth/admin.ts`，登录的接口在 `auth/admin-routes.ts`，密码只存 scrypt 哈希（`auth/password.ts`）；同一个 IP 一小时输错 10 次就暂停。GitHub 不是登录方式，只在设置里关联（`src/server/github/link.ts`）。登录状态在 `auth/login-sessions.ts`（`login_sessions` 表，只存哈希）：网页用 Cookie；安卓 App 登录时带 `client: "app"` 和设备名，拿到设备令牌，之后放在 `Authorization: Bearer` 里（#177），带了它就只按令牌认、不看 Cookie、不做同站检查；App 的令牌每次用都顺延 30 天。设备列表是 `/api/auth/devices`（设置的"账户"里能单独退出一台）。两步验证（#100 的 TOTP 部分）：算法在 `auth/totp.ts`（RFC 6238，前后各容许一个时间步，同一个时间步的验证码不能用两次），开启、核对、恢复码在 `auth/two-factor.ts`（密钥用 SecretBox 加密存在 `users`，恢复码只存哈希，`recovery_codes` 表），接口在 `auth/two-factor-routes.ts`；开了以后 `/api/auth/login` 回 202 和 5 分钟的加密中间令牌 `pendingToken`（不是登录状态，只能拿去 `/api/auth/login/verify`），App 登录也走这一步；改密码、关闭、重新生成恢复码要再输密码和验证码（`reauthenticate`）；输错验证码和输错密码共用一个频率限制（`auth/limits.ts`）；重置命令同时关掉两步验证、删掉通行密钥。通行密钥（WebAuthn）在 `auth/passkeys.ts`（SimpleWebAuthn 核对；要求用户验证；挑战值一次性、5 分钟，放在内存里；rpId 和来源按 `PUBLIC_URL`，没配或不是 HTTPS（本机 localhost 除外）时用不了），接口在 `auth/passkey-routes.ts`（添加、删除要再验证；通行密钥登录不用密码和验证码，失败计入同一个频率限制）；测试里 `createTestApp()` 的主站地址是 `TEST_PUBLIC_URL`，`src/testing/fake-authenticator.ts` 是假的认证器（P-256，attestation 为 none）。事件流每次保活（`streamKeepaliveMs`，默认 25 秒）再核对一次登录状态，退出了就断开。`/api/health` 的 `minAppVersion`（`app.ts` 的 `MIN_APP_VERSION`）是支持的最低 App 版本。
- 扩展点（ADR 0010）：`AppDeps` 里的 `identity`（身份来源）和 `settingsPolicy`（设置的读写规则），接口在 `apps/site/src/server/ports.ts`，主干的实现是 `auth/admin-identity.ts` 的 `adminIdentity` 和 `settings.ts` 的 `adminSettings`，在 `main.ts` 里组装。接口里判断是谁一律用 `deps.identity.currentUser(c)`，不直接用 `auth/login-sessions.ts`；设置一律用 `settings.ts` 的 `readSetting`、`writeSetting`，加一项设置就在 `SETTINGS` 里加一行。`extension-rules.test.ts` 读源码守住这几条。下游只从包的出口拿东西：`@seekcloud/site/server`（`src/server/index.ts`）和 `@seekcloud/site/testing`（`src/testing/index.ts`）；下游的表放自己的迁移目录，用 `runMigrations(db, [{ folder, table }])`。
- 浏览器端的扩展点（ADR 0010）在 `apps/site/src/client/registry.tsx`：页面（地址样式、组件、要不要登录、是不是盖在页面上的弹窗）、设置分类（加一类只登记一项，`order` 排顺序）、四个插槽（`sidebar-foot`、`composer-below`、`session-banner`、`home-below-greeting`，页面上用 `<Slot name="..." />`）。主干自己的在 `client/trunk.tsx` 登记，`main.tsx` 只做登记和挂载（`mountApp`）；登录后的页面从 `useShell()`（`client/shell.tsx`）拿管理员、会话列表这些。路由（`router.ts`）查这张表，找不到的地址回首页。下游从 `@seekcloud/site/client`（`src/client/index.ts`）拿。
- 加了路径里带某个人的数据 ID 的接口（`/api/sessions/{shortId}/...` 这类），要在 `server/isolation.test.ts` 的清单里加一行，漏了测试就失败：它用测试替身 `FakeIdentity`（`src/testing/fake-identity.ts`）放进第二个人，拿对方的 ID 调每个接口。身份来源的契约测试在 `src/testing/identity-contract.ts`，最小下游样例在 `src/testing/downstream-example/`（起一个真的 HTTP 服务）。
- 宿主机连接（#91）：守护进程用宿主机密钥主动连主站的 WebSocket（`/api/hosts/connect`）。握手、帧、序号和补发、协议版本的规矩在 `packages/protocol/src/link.ts` 和 `index.ts` 的 `PROTOCOL_VERSION` 注释（加命令、事件不升版本；相差一个版本要能互通）。主站这边是 `apps/site/src/server/hosts/`：`hub.ts` 的 `HostHub`（真的 `HostLink`，管多台宿主机，`sessions.host_id` 记会话在哪台，宿主机只能上报自己名下的会话，断线超过设置 `host_offline_grace` 的时长把运行中的会话标为失败）、`keys.ts`（密钥只存哈希）、`credential.ts`（宿主机凭据的中间件 `hostAuth`，模型网关这些路由挂上它）、`frames.ts`（宿主机发来的帧逐个校验）。添加、吊销宿主机：在 `apps/site` 里 `DATABASE_URL=... pnpm host:create <名字>`、`pnpm host:revoke <名字>`。守护进程这边是 `apps/host/src/site-link/`（`SiteLink` 断线自动重连，`commands.ts` 把命令接进 Git 代理的会话表和沙箱，沙箱的操作每个会话排一队在后台做，不挡别的会话；没配沙箱镜像时准备沙箱回"建不了沙箱"），环境变量 `SEEKCLOUD_SITE_URL`、`SEEKCLOUD_HOST_KEY`。测试：主站用 `createTestApp({ hosts: true })` 起真的 HTTP 服务，`src/testing/host-client.ts` 的 `TestHostClient` 扮演守护进程（`t.hub.tick()` 跑定时检查）；守护进程的测试里扮演主站（`site-link.test.ts`）。其余测试照旧用假宿主机 `t.host`。
- 模型网关（#26）在 `apps/site/src/server/gateway/`：`gateway.ts` 的 `ModelGateway`（Messages 的转发、流式改写、用量；`passThrough()` 是每个提供方的透明转发（#113：请求体原样转给 基础 URL + 剩下的路径，换上真 key，流式原样传回，Chat Completions 的流补 `stream_options.include_usage`，不跟重定向）；`text()` 是平台自己发起的模型调用的内部入口，按模型的协议发最简单的文字请求，起标题、置顶短标题、判断是否在等输入都走它）、`usage.ts`（四种协议的用量：非流式读响应体，流式用 `UsageMeter` 一个事件一个事件地读；口径照 Anthropic，OpenAI、Gemini 的输入减掉读缓存）、`provider-path.ts`（透明转发的路径检查、按路径认协议、取模型）、`files.ts`（Files 接口：文件转给提供方存，`model_files` 记是哪个会话传的，列表、删除、Messages 里引用都只认本会话的）、`web.ts`（联网搜索，DeepSeek 搜索接口的格式，结果只留几个字段）、`fetch.ts` 和 `html.ts`（网页抓取：主站自己去取，网页转成 Markdown，嵌套太深的先线性地估出来、改用纯文本提取）、`upstream.ts`（Files、搜索这类不分模型的接口往上游发请求）、`failures.ts`（上游出错时记原始报错、给调用方的说明和参考号）、`trunk.ts`（三个扩展点的主干实现：`usageAdmission` 记用量、`configuredRouting` 按设置里的提供方（`route()` 按"提供方/模型"，认证头按协议放：`authHeaders`；`service()` 给 Files 和联网搜索，只有 DeepSeek）、`transparentErrors` 对管理员透明）。接口是 `routes/gateway.ts`（`/api/gateway/v1/messages`（DeepSeek 官方的 Anthropic 格式）、`/providers/{id}/…`（透明转发）、`/v1/files…`、`/v1/tools/search`、`/v1/tools/fetch`，调用方只有宿主机，带宿主机凭据和 `X-SeekCloud-Session`；不过同站检查，因为不看 Cookie）和 `routes/model.ts`（设置的"模型"：`/api/settings/model-providers…`，获取可用模型 `…/probe`（`models/probe.ts`，读 `data` 数组或 `models` 对象，目录里的提供方由目录作答），按参考号查上游原始报错 `/api/model-errors/{ref}`）。提供方和模型（#113，照 dsh 的"设置 → 模型"）在 `apps/site/src/server/models/`：`providers.ts`（`model_providers` 表：内置的 DeepSeek、目录里的、自定义接口；`provider_models` 是自己改过的模型列表；key 用 `SEEKCLOUD_SECRET_KEY` 加密，没填时读主站进程的环境变量（`credentialOf`）；`ModelCatalog` 列能用的模型、按"提供方/模型"找、选默认模型和平台调用的模型，主站只建一个（`createModelCatalog`，main.ts 里传给路由和 `createApp`））、`catalog.ts` 和 `catalog.json`（第三方提供方的目录：从 dsh 用的 `@earendil-works/pi-ai` 生成的快照，升级 dsh 时在 `apps/site` 里 `pnpm model-catalog <装了 dsh 的 node_modules>` 重新生成；DeepSeek 内置的两个模型）、`deepseek-listing.ts`（DeepSeek 发布的模型列表，照 dsh 的规则读和缓存）、`mask.ts`（key 的脱敏预览，照 dsh）。会话、设置、用量里记的模型是"提供方/模型"（协议包的 `parseModelRef`，没有斜杠的旧写法当作 DeepSeek 的）；发给宿主机的命令里 `model` 和 `provider` 分开写。改提供方要问设置的规则（`model_providers` 这一项的 `canWrite`）。测试里 `createTestApp({ env })` 是主站读到的环境变量（默认空的），`createTestApp({ deepseekListing: {} })` 打开 DeepSeek 发布的列表（默认关）。模型用量在 `model_usage`，联网工具的次数在 `web_tool_usage`，上游原始报错在 `upstream_errors`（保存 30 天）。测试里 `t.model`（`src/testing/fake-model.ts`）是假的提供方（Files 真的存在内存里），`src/testing/gateway-client.ts` 的 `gatewayRequest` 扮演宿主机调网关，`createTestApp()` 默认填好了一个假 key，`createTestApp({ modelKey: false })` 是还没填；三个扩展点的契约测试在 `src/testing/model-contracts.ts`。主站去连外面的地址（抓取，以后的自接 MCP、插件索引）一律经过 `server/network/address.ts`（按解析后的 IP 判断，不连内网、本机和元数据地址）；网络策略的域名匹配和默认清单在 `server/network/policy.ts`（给 #47 的出站代理用；抓取不受网络策略约束）。抓取的测试把假网站开在 127.0.0.2 上，用 `createTestApp({ outboundNetwork })` 换掉域名解析。宿主机这一半在 `apps/host/src/model-gateway/forward.ts`：Git 代理端口上的 `/v1/…` 核对会话临时令牌后转给主站（dsh 怎么配见 `apps/host/sandbox/README.md` 的"模型网关"）。
- 主站和宿主机之间的消息定义在 `packages/protocol`。主站通过 `apps/site/src/server/sessions/host.ts` 的 `HostLink` 和宿主机通信；测试里是 `t.host`（`src/testing/fake-host.ts`，按脚本回放 Agent 事件，`manual = true` 时由测试自己 `emit`）。会话编排在 `src/server/sessions/sessions.ts`。
- 宿主机（`apps/host`）：GitHub 工具服务（MCP，`/mcp`）在 `src/github-tools/`，测试接假的 GitHub API；dsh 怎么接见 `apps/host/sandbox/README.md`。Git 代理在 `src/git-proxy/`，提交签名在 `src/signing/`，沙箱里要装的签名助手和 git 配置在 `apps/host/sandbox/`。测试用真的 `git`（`git http-backend` 当假 GitHub）、`openssl` 和 `ssh-keygen`，云端会话里先运行 `apt-get install -y openssh-client`。生成签名密钥：`pnpm --filter @seekcloud/host signing-key <私钥路径>`，打印出来的公钥加到 SeekCloud 账号的 GitHub 签名密钥里。dsh 的基线配置（`apps/host/sandbox/dsh/baseline.patch.yml`）和 Claude Code 技能的插件（同目录的 `claude-code-skills.js`）的测试在普通 CI 里只查文件、用假的 dsh 上下文；要用真的 dsh 验（`src/dsh-real.test.ts`：真的 dsh 跑一个回合，模型服务是假的 `src/testing/fake-model-server.ts`，用 `DEEPSEEK_BASE_URL` 指过去），在一个临时目录里用 Node 24.9 以上运行 `npm i @deepseek-ai/dsh@$(cat apps/host/sandbox/dsh/VERSION)`，再设 `SEEKCLOUD_DSH_BIN=<临时目录>/node_modules/.bin/dsh` 跑宿主机的测试（PATH 里的 node 也要是 24.9 以上）。CI 的 dsh 那一项就是这么跑的。宿主机的环境变量：`SEEKCLOUD_SITE_URL`（主站对外的地址）、`SEEKCLOUD_HOST_KEY`（宿主机密钥）、`SEEKCLOUD_VERSION`、`SEEKCLOUD_SIGNING_KEY`（签名私钥路径）、`SEEKCLOUD_SIGNER_EMAIL`（SeekCloud 账号的邮箱）、`SEEKCLOUD_GIT_PROXY_HOST`、`SEEKCLOUD_GIT_PROXY_PORT`、`SEEKCLOUD_HOST_DATA`。
- 沙箱（#18、ADR 0005）在 `apps/host/src/sandbox/`：`sandboxes.ts` 的 `Sandboxes`（按会话 ID 建、启、停、删 Sysbox 容器，守护进程重启后按容器标签认回；`exec` 在沙箱里跑命令，超时杀掉它起的所有进程；`protect` 把 Agent 的进程设成内存用满时不杀）、`network.ts`（专用网络 `seekcloud-sandbox`，网桥 `seekcloud0`，沙箱之间不通；`applyFirewall` 只放行网桥地址上给沙箱的端口）、`docker.ts`（调 docker 命令行，参数只用数组）。守护进程要用 root 跑（防火墙、OOM 优先级）。宿主机的环境变量：`SEEKCLOUD_SANDBOX_IMAGE`（不配就不建沙箱）、`SEEKCLOUD_SANDBOX_RUNTIME`（默认 `sysbox-runc`）、`SEEKCLOUD_SANDBOX_CPUS`（默认 4）、`SEEKCLOUD_SANDBOX_MEMORY_MB`（默认 4096）、`SEEKCLOUD_SANDBOX_SUBNET`（不配由 Docker 挑）；Git 代理默认监听网桥的地址。单个沙箱的磁盘配额用 XFS 项目配额做（#168，ADR 0005 的"磁盘配额"）：`disk-quota.ts` 给沙箱的可写层（从 mountinfo 读的 upperdir、workdir）和沙箱自己的 `/var/lib/docker`（宿主机的 `SEEKCLOUD_SANDBOX_DATA/<会话>/docker`，默认 `/var/lib/seekcloud/sandboxes`）设同一个项目和上限 `SEEKCLOUD_SANDBOX_DISK_GB`（默认 30）；存储不是开了 prjquota 的 XFS 时不限，上报 `diskQuota: false`。测试机要用引导脚本的"沙箱的存储"一步把 Docker、containerd、Sysbox 的数据搬到 XFS 上，`disk-quota.sysbox.test.ts` 的配额那一半才不跳过。准备工作区在 `provision.ts`：装 CA、写 `/etc/gitconfig` 和 `/etc/seekcloud/github.env`、克隆到 `/workspace/<名字>`、切到会话分支，克隆失败回 `repo_clone_failed`。dsh 给它跑的命令去掉名字里带 KEY、PASSWORD、SECRET、TOKEN 的环境变量：要传给命令的值换个名字（钩子路径用 `GIT_CONFIG_PARAMETERS`），带令牌的放文件（`provision.test.ts` 守着）。
- 沙箱的测试（缝 ②）：`src/sandbox/*.docker.test.ts` 设 `SEEKCLOUD_DOCKER_TESTS=1` 才跑，本机有 Docker 就行（运行时默认 `runc`）。云端会话里先在后台起 `dockerd`，再 `SEEKCLOUD_DOCKER_TESTS=1 pnpm --filter @seekcloud/host exec vitest run src/sandbox`。云端会话的 root 调不低 OOM 优先级，那一半会跳过。`*.sysbox.test.ts`（沙箱里跑 Docker、用户映射、Sysbox 的数据目录）只在测试机上跑。测试机上 Runner 不是 root，防火墙和 OOM 优先级借特权容器做（`SEEKCLOUD_TEST_ROOT=docker`）。Docker Hub 不登录拉镜像有次数限制，测试只在本机没有镜像时才拉。
- Agent 适配接口（#25）在 `apps/host/src/agent/`：
  - **运行器**：dsh 由沙箱里常驻的运行器托管（`apps/host/sandbox/runner/seekcloud-runner.mjs`，守护进程断开重连不丢、不重复），守护进程这边连它的是 `runner-link.ts`。
  - **适配接口**：`dsh-agent.ts` 的 `DshAgent` 用 SDK（JSON-RPC）驱动 dsh。开始回合先 initialize，不是会话的第一个回合就先 `session/resume`（被拒就失败），再 `session/prompt`。插话再发一次 prompt；停止就停掉 dsh 进程；换模型、思考强度就重启 dsh。
  - **事件转换**：`dsh-events.ts` 把 dsh 的事件转成协议包的事件；平台的回合到整个 Agent 闲下来才结束。
  - **沙箱里的接法**：`sandbox-agents.ts`。dsh 经 Git 代理端口上的模型网关调模型，API key 是会话临时令牌，权限是 `danger-full-access`（沙箱就是边界）。`start_turn` 的 `firstTurn` 由主站按"这个会话以前有没有回合到过 Agent"填。
  - **逐字输出**：靠基线配置插进的 `apps/host/sandbox/dsh/live-output.js`，写到 dsh 的第 4 个文件描述符。
  - **系统提示词**：是基线配置里 `system-prompt` 的 `personaSuffix`。
  - **测试**：
    - 契约测试（缝 ③）`dsh-agent.real.test.ts`：真的 dsh、本机的运行器、按脚本回复的假模型（`src/testing/fake-model-server.ts` 的 `script`），设 `SEEKCLOUD_DSH_BIN` 才跑；
    - `runner.test.ts` 用假的 dsh；
    - `dsh-events.test.ts` 不用 dsh。
  - dsh 0.2.2-rc.3 的 SDK 实测结果见 #25 的 2026-11-18 评论。
  - **回合收尾**（#27）：`turn-end.ts`。`SandboxAgents` 在回合开始时记下各仓库会话分支的提交；回合结束（包括停止、失败）时补提交没提交的改动（`--no-verify`，说明"SeekCloud：保存第 N 回合未提交的改动"），只推会话分支、不强推，算出这一回合改了的文件，先发 `workspace` 再发 `turn.ended`。主站在 `sessions.ts` 收：已停止的回合晚到的 `workspace` 也记，推送失败开跟进回合（`user.message` 的 `followUp`），同一条管理员消息最多 `MAX_PUSH_FOLLOW_UPS` 次，之后记 `push.gave_up`。界面的改动卡片在 `client/session/ChangesCard.tsx`。
  - **还没做的**：
    - 选择题和批准的卡片：现在不开批准；dsh 问选择题时回不支持；
    - 命令时长；
    - 守护进程重启时不打断正在跑的回合（#111）。
- 通用镜像（#17）在 `apps/host/sandbox/image/`：`Dockerfile`（构建上下文是 `apps/host/sandbox`，构建命令见 `apps/host/sandbox/README.md` 的"通用镜像"）、`check.sh`（镜像的自检，在沙箱里跑）、`VERSION`（镜像的版本号）。改了 `apps/host/sandbox/` 下的东西，推送以后看测试机上 Sandbox image 工作流的结果（构建要十来分钟）。云端会话里的容器上不了网，镜像只在测试机上构建。
- 测试机（#14，用户买的一台香港 KVM 云服务器，装 Docker Engine 和 Sysbox）：注册成本仓库的 GitHub 自托管 Runner，标签 `sysbox`，测试机上不装、不登录 Claude 的任何东西（用户 2026-11-18 定的）。引导脚本是 `scripts/test-machine.sh`（检查是不是完整的虚拟机、装 Docker 和 Sysbox、自检、注册 Runner），用户在测试机上 `curl -fsSLo test-machine.sh https://raw.githubusercontent.com/bilixuesheng/SeekCloud/main/scripts/test-machine.sh && sudo bash test-machine.sh`。要真沙箱的测试单独一个工作流，`runs-on: [self-hosted, sysbox]`，只在本仓库分支的推送和手动触发时跑，不用 `pull_request` 触发；会话推送以后看这个工作流的结果和日志，上不了机器调试。测试机的地址、密码不写进仓库和工单；工作流的日志是公开的，测试和脚本里也不打印网卡地址（2026-11-18 探查时打印过一次公网地址，那次的日志已经删了）。
- 浏览器测试（`*.browser.test.ts`，现在有侧栏的拖动 `client/session/sidebar-drag.browser.test.ts`、底部弹层的动画 `sheet.browser.test.ts` 和英文界面的冒烟测试 `client/i18n/english.browser.test.ts`）：设 `SEEKCLOUD_BROWSER_TESTS=1` 才跑，要先在 `apps/site` 里 `pnpm build`；用 `playwright-core`（版本和云端会话里装好的 Chromium 一样，不用另装浏览器），触摸经 CDP 的 `Input.dispatchTouchEvent` 发，是真的触摸事件。`src/testing/preview-server.ts` 的 `startPreview(t)` 起一个能用浏览器打开的主站（接口转给 `createTestApp()`，别的给构建好的网页），截图也用它（脚本里要先 `createTemplateDatabase()`）。CI 的 browser 那一项就是这么跑的。
- SSE 接口用 `browser.stream(path)` 测（`src/testing/event-stream.ts`），用完要 `close()`。`t.admin()` 得到一个已登录的管理员浏览器（第一次调用时用 `t.adminPassword` 设置密码，每次调用都是一台新设备）；`t.adminWithGitHub(login, ...仓库)` 再关联 GitHub、装好 App，再调用一次会换成新的 GitHub 账号。
- 主站的测试用 `apps/site/src/testing/test-app.ts` 的 `createTestApp()`：进程内调用接口，每调用一次建一个独立的库（一般一个测试文件一次），时钟是假的。`t.browser()` 模拟一个有自己 Cookie 和 IP 的浏览器，`browser.clone()` 复制一份带着同样 Cookie 的。`createTestApp({ identity, settingsPolicy })` 换掉扩展点；换了身份来源以后用 `t.linkGitHub(浏览器, login, ...仓库)` 给已登录的浏览器关联 GitHub。
- 主站的每个响应都带内容安全策略（`apps/site/src/server/app.ts`）：脚本只能来自本站，页面里不能写内联脚本，要在页面画出来之前跑的放进 `apps/site/public/` 下单独的文件（比如 `theme-boot.js`）。接口的请求体最多 1 MB（webhook 25 MB）。
- Agent 回复里的图片只有 GitHub 和主站自己的直接显示，别的来源点了才加载（`session/Markdown.tsx` 的 `trustedImageHost`）：图片地址是 Agent 写的，直接加载等于给了它一条往外送数据的路。
- 要看界面时，可以用假 GitHub、假宿主机起一个真主站来截图：照 `apps/site/src/testing/test-app.ts` 的写法建 `createApp()`，再挂上 `dist/client` 的静态文件。
- 界面的通用组件在 `apps/site/src/client/ui/`（2026-11-22 用户要求设置页不要粗糙）：`toast.tsx`（右下角可堆叠的通知，手机上在底部；`toast(文字, "success" | "error" | "info")`，读取或操作失败用 `useErrorToast(error)`；操作结果一律用它，不在页面里插提示）、`confirm.tsx`（`await confirmDialog({ title, body, confirmText, danger })`，退出、删除这类确认一律用它，不在原地把按钮换成"确认"）、`modal.tsx`（要填东西的操作放进弹窗：改密码、两步验证、通行密钥、模型目录、连接设置、添加提供商）、`select.tsx`（自己画的下拉框，可以分组；设置里不用浏览器自带的下拉框）。弹窗可以叠着开（编辑一个模型），Esc 只关最上面的。设置的每一节都是外置的小标题（`settings-section`），不再套带图标的卡片。弹窗、通知、下拉列表的进出都带模糊，系统开了"减少动效"时不播。通知和确认弹窗挂在 `mountApp` 里，哪一页都能用。
- 接口出错时统一返回 `{ error: { code, message } }`：`code` 给程序判断，`message` 是给人看的中文。用 `apps/site/src/server/errors.ts` 的 `apiError()`。浏览器端认得的 `code` 用文案目录里的话（`i18n/errors.ts` 的 `errorText`，目录里写成 `error.<code>`），不认得的显示 `message`。
- 界面文案（#135，规格 #134）在 `apps/site/src/client/i18n/`：`zh.ts` 是基准目录，`en.ts` 的类型要求键完全一样；组件里 `const t = useT()`（换语言时重画）再 `t("键", { 插值 })`，带元素的用 `tRich`；`{brand}` 自动换成品牌名（中文"云上求索"，英文 SeekCloud）；英文分单复数写 `{ one, other }`，按 `{count}` 选。日期、时间用 `i18n/format.ts`（Intl）。选语言：设置里的"语言"（全站设置 `language`，`/api/settings/language`）→ 浏览器语言列表里第一个支持的 → 英文；浏览器里另记一份，`public/locale-boot.js` 在页面画出来之前设好 `<html lang>`、标题和 PWA 清单（`public/manifest.zh-CN.webmanifest`、`manifest.en.webmanifest`）；登录页右上角能切换，登录后 `i18n/sync.ts` 和主站对一下。下游用 `mountApp(root, registry, { messages })` 叠一层目录。`i18n/hardcoded.test.ts` 扫描文案目录以外所有文件里写死的汉字（没有豁免清单）；给开发者看的话在那一行注明"不是界面文案"。按状态、结果挑文案的表用 `Record<…, PlainKey>`（不带插值的键）。首页的问候语每种语言一套（`i18n/greetings-zh.ts`、`greetings-en.ts`，规则在 `session/greetings.ts`）。服务端不存给人看的现成句子：默认环境的名字、内置 DeepSeek 的名字、取不出的置顶短标题存空的，目录里提供方的名字存英文正式名称，登录设备的浏览器存英文正式名称，界面按语言显示（`environmentLabel`、`providerLabel`）。测试固定用中文跑（`src/testing/locale-setup.ts`，浏览器测试开页面时写 `locale: "zh-CN"`），测英文的自己 `resetForTests("en")`；英文界面的冒烟测试是 `i18n/english.browser.test.ts`（看得到的文字和读屏文字里没有汉字），迁完一批页面就在里面加上那几页。
- 全站设置（管理员在设置窗口里改的配置）存在 `settings` 表里，一项一行，读写都走 `apps/site/src/server/settings.ts`；接口在 `routes/settings.ts`（`/api/settings/...`）。现在有 AI 标识的两个开关（随准备沙箱的命令下发给宿主机，改了以后给沙箱还开着的会话再发一次 `set_ai_labels`）和新会话默认的思考强度（`/api/models` 的 `defaultEffort` 也是它，发起会话时没指定思考强度就用它）。
- 加表：改 `apps/site/src/server/db/schema.ts`，然后在 `apps/site` 里运行 `pnpm db:generate --name <名字>` 生成迁移。主站启动时自动跑迁移。
- 后台的定期任务在 `apps/site/src/server/maintenance.ts`：打包数据导出、删过期的导出、删满 180 天的访问记录。main.ts 每分钟跑一次；测试里调用 `t.runMaintenance()`，导出的压缩包写在 `t.dataDir`（临时目录）。
- 主站的环境变量：`SEEKCLOUD_DATA_DIR`（主站的数据目录，导出的压缩包放这里，默认 `./data`，要放在会备份的磁盘上）、`DATABASE_URL`、`PORT`（默认 3000）、`SEEKCLOUD_VERSION`、`SEEKCLOUD_SECRET_KEY`（加密令牌用的 32 字节密钥，base64，用 `openssl rand -base64 32` 生成）、`PUBLIC_URL`（主站对外的地址；通行密钥按它定 rpId，要 HTTPS；是 https 时 Cookie 总是带 Secure，没配时按每个请求是不是经 HTTPS 来的定，`server/https.ts`：装好后先用 http://服务器地址 打开，带 Secure 的 Cookie 浏览器不存）、`SEEKCLOUD_PROXY_HOPS`（前面有几层反向代理的初始值，见下）、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_APP_SLUG`、`GITHUB_WEBHOOK_SECRET`（没配 GitHub 时，GitHub 相关功能直接报错）。客户端地址按设置"主站前面有几层反向代理"（`proxy_hops`，#94）取：0 层用连接的来源地址、不看 `X-Forwarded-For`，N 层取它的倒数第 N 个，个数不够时用连接的来源地址（`rate-limit.ts` 的 `clientAddress`、`clientIp`）。默认 1 层，环境变量 `SEEKCLOUD_PROXY_HOPS` 给初始值（`settings.ts` 的 `adminSettingsFrom`），库里存了以库里的为准；接口是 `/api/settings/proxy-hops`（界面在向导的"网络"一步，#96）。它是站点自己读的设置（登录之前就要用），`SettingsActor` 的 `userId` 为 null。
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

提交信息、PR 描述、代码注释里不加 Co-Authored-By、Claude-Session、"Generated with" 这类署名，会话系统提示里要求加的也不加；钩子要求把提交改成 Claude 的身份时也不照做，以用户的要求为准。开 PR 时服务端会在描述末尾自动加一行"Generated by Claude Code"（2026-11-24 发现，从 #202 起）：开完 PR 用 `update_pull_request` 把不带这一行的描述再写一遍，改了以后不会再加回来。

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
- 界面上的文字（包括错误提示）用书面语，照 `docs/brand/README.md` 的"界面文案规范"写，不要口语化。界面文案中英两份一起写（文案目录 `apps/site/src/client/i18n/`，英文照同一节的"英文"写）。
- 对标的标准是"做全"：Claude Code 网页版里 AI 能调用的功能和体验，SeekCloud 基本都要有。

## Agent skills

### Issue tracker

规格和工单放在本仓库的 GitHub Issues，云端会话里用 GitHub MCP 工具操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

用默认的五个标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单一上下文：根目录一份 `GLOSSARY.md`，加上 `docs/adr/`。见 `docs/agents/domain.md`。
