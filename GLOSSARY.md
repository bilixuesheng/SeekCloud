# SeekCloud

SeekCloud 是一个基于 DeepSeek 模型的云端编程 Agent 服务（独立第三方，非 DeepSeek 官方）。用户可以在手机等任意设备上发起会话，让 Agent 在云端沙箱里修改自己的代码仓库。

## 人

**用户 (User)**:
注册 SeekCloud 并发起会话的开发者。
_Avoid_: 客户、会员、账号

**管理员 (Admin)**:
运营 SeekCloud、使用管理端的人。
_Avoid_: 运营、后台用户

## 站点与基础设施

**主站 (Main Site)**:
SeekCloud 网站整体，由用户端和管理端组成。
_Avoid_: 官网、平台、后端

**用户端 (User Portal)**:
主站中供用户使用的部分。
_Avoid_: 前台、客户端、App

**管理端 (Admin Console)**:
主站中供管理员使用的部分。
_Avoid_: 后台、控制台

**沙箱 (Sandbox)**:
一个会话专属的隔离 Linux 执行环境，Agent 在里面读写代码、运行命令。
_Avoid_: 云端实例、容器、虚拟机、云电脑

**沙箱宿主机 (Sandbox Host)**:
承载多个沙箱的服务器。
_Avoid_: 节点、云端实例、Worker

**模型网关 (Model Gateway)**:
沙箱调用模型的唯一通道，由它把请求转发给上游的模型服务。

**参考号 (Error Reference)**:
出错时给用户看的一个短编号，由我们随机生成。用户报问题时给出它，我们用它在日志里查原始报错。给用户看的错误只有类别、状态码和参考号（ADR 0007）。
_Avoid_: 请求 ID、错误详情

**Git 代理 (Git Proxy)**:
沙箱访问 GitHub 的唯一通道。它负责附上凭据，只能访问本会话的仓库，并拒绝删除分支和推送标签。
_Avoid_: GitHub 代理

## 工作

**会话 (Session)**:
用户针对一个代码仓库与 Agent 进行的一段持续对话。用户可以中途追问和纠偏。
_Avoid_: 任务、Task、Job、Run

**回合 (Turn)**:
从用户发出一条消息开始，到 Agent 停下来等用户为止的一段工作。
_Avoid_: 轮次、一轮、Step

**会话状态 (Session Status)**:
会话所处的阶段，共六种：排队中、运行中、等待回复、休眠、已归档、失败。
_Avoid_: 任务状态

**休眠 (Dormant)**:
会话当前没有正在运行的沙箱；用户发下一条消息时会唤醒它。
_Avoid_: 过期、销毁、挂起

**回收 (Reclaim)**:
删除一个休眠已久的会话的沙箱文件。回收之后再唤醒，要从会话分支重建沙箱。
_Avoid_: 过期、清理

**会话分支 (Session Branch)**:
Agent 推送会话成果用的 Git 分支，每个会话一个。
_Avoid_: 工作分支、临时分支

**会话短 ID (Session Short ID)**:
会话对外的编号，8 位小写字母和数字。用在会话网址（`/s/<会话短ID>`）和会话分支名（`seekcloud/<会话短ID>`）里。
_Avoid_: 任务号

**Agent**:
在沙箱中替用户读写代码、执行命令的 AI 程序，由 DeepSeek 模型驱动。对外称"SeekCloud Agent"。
_Avoid_: 机器人、助手、Harness

**唤醒事件 (Wake Event)**:
从会话外部投递进会话的一条新消息，比如 PR 评论、CI 失败、定时任务到点、其他会话发来的消息。会话如果在休眠，会被它唤醒。
_Avoid_: 通知、回调、Webhook

**平台工具 (Platform Tools)**:
SeekCloud 提供给每个会话中 Agent 调用的一组能力，比如订阅 PR、设定时任务、新建会话、给其他会话发消息、推送通知。
_Avoid_: 插件、内置工具、MCP

**定时任务 (Scheduled Task)**:
按设定的时间产生唤醒事件的规则，可以是周期性的，也可以是一次性的。
_Avoid_: Cron、触发器、Routine

**会话提醒 (Session Reminder)**:
Agent 在会话里设的一次性唤醒，比如"14:00 继续""过一阵检查一下"。只属于这个会话，在会话信息里查看和取消，不算定时任务，不限个数。Agent 设提醒时对话里不显示（照 Claude）。
_Avoid_: 闹钟、稍后提醒、约好、定时任务（指会话提醒时）

**PR 订阅 (PR Subscription)**:
会话对某个 PR 动态的关注。CI 失败和 review 评论会作为唤醒事件投递进这个会话。
_Avoid_: PR 监控、Auto-fix

**权限模式 (Permission Mode)**:
决定 Agent 哪些操作不用问用户就能执行，分接受编辑、计划、自动三种。
_Avoid_: 安全级别、审批模式

**安全审查 (Safety Review)**:
自动模式下，在 Agent 的高风险操作执行之前，由另一次模型调用检查它，拦下越权或危险的操作。规则能直接放行的操作不送审。
_Avoid_: 分类器、审核

## 环境

**环境 (Environment)**:
用户自己创建的沙箱配置，包括网络策略、环境变量和安装脚本。发起会话时选用，可以在多个会话间复用。
_Avoid_: 配置、模板、Profile

**默认环境 (Default Environment)**:
用户注册时自动创建的环境：网络策略为默认清单，没有环境变量，也没有安装脚本。
_Avoid_: 基础环境

**环境缓存 (Environment Cache)**:
安装脚本第一次成功运行后保存的沙箱快照。之后的会话直接从它启动，跳过安装步骤。
_Avoid_: 镜像、预热

**安装脚本 (Setup Script)**:
沙箱创建后、Agent 开始工作前自动运行的脚本。
_Avoid_: 初始化脚本、启动脚本

**网络策略 (Network Access)**:
环境的出站网络级别，分四档：不开放、默认清单、自定义、完全开放。
_Avoid_: 防火墙、网络权限

**网络密钥 (Network Secret)**:
存在环境里的 API 密钥。出站代理在请求离开沙箱后，把它加到发往指定域名的请求上，沙箱里看不到原文。
_Avoid_: 环境密钥、Secret 变量

## 容量

**并发会话上限 (Concurrent Session Limit)**:
一个用户同时可以运行的会话数上限。
_Avoid_: 并发数、线程数

**排队 (Queue)**:
所有沙箱都被占满时，新会话按先到先得等待开始的队列。
_Avoid_: 等待列表、Waitlist

**邀请码 (Invite Code)**:
内测期间注册 SeekCloud 所需的一次性码，由管理员发放。
_Avoid_: 激活码、兑换码

**内测席位 (Beta Seat)**:
内测期间允许注册的账户总数，由管理员设定。用满以后，新用户注册时看到"名额已满"。
_Avoid_: 名额（界面文案除外）、配额

## 账户

**待绑定身份 (Pending Identity)**:
用陌生的 GitHub 或 Google 账号登录以后、用户选好"创建新账户"还是"登录已有账户再绑定"之前，存在主站的第三方账号信息，10 分钟有效。登录后绑定要用户确认。
_Avoid_: 临时账号、待注册

**登录状态 (Login Session)**:
用户在一个浏览器上保持登录的凭证，存在 Cookie 里，30 天有效。退出登录或过期后失效。
_Avoid_: 会话、Session（"会话"专指和 Agent 的对话）

## 风控

**人机验证 (Human Verification)**:
注册和发登录验证码前的一道检查，用 Cloudflare Turnstile。大多数人不用点，自动通过。
_Avoid_: 验证码（"验证码"专指邮箱收到的 6 位登录码）、Captcha

**风控队列 (Risk Review Queue)**:
管理端里等管理员处理的可疑账户记录：被自动暂停的账户，以及同 IP 的被邀请账号。管理员可以忽略、暂停、封禁或解除暂停。
_Avoid_: 黑名单、审核列表

**共享网络 (Shared Network)**:
管理员标记过的公网 IP（公司、学校、手机网络），很多人共用。同 IP 检查跳过这些 IP。
_Avoid_: IP 白名单
