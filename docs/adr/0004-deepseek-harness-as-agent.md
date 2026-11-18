# 用 DeepSeek Harness（dsh）作为沙箱里的 Agent

> **2026-11-18 补充**：怎么改 dsh 改了，见文末"改 dsh 的方式"。另外，关遥测的环境变量是 `DSH_TELEMETRY_MODE=DISABLED`，不是下文的 `DSH_TELEMETRY_DISABLED=1`。

Claude Code 网页版在云端跑的是 Anthropic 自家的 Claude Code。为了对标这一点，SeekCloud 在沙箱里跑 DeepSeek 官方的 DeepSeek Harness（`dsh`，MIT 许可）。DeepSeek 说过它的模型专门为 dsh 调过。

Agent 的叫法分两处：

- 管理员自己看的界面和导出的文件写 DeepSeek，比如"DeepSeek 已读取""DeepSeek 是 AI 并且可能会犯错。"；
- 留在 GitHub 上的署名、提交尾注和提交作者的名字写 SeekCloud：`_由 SeekCloud 生成（AI）_`、`Generated-by: SeekCloud (AI)`。署名和提交尾注默认加上，管理员可以在设置里分别关掉。这些是公开的，DeepSeek 开放平台协议 §5.3(2) 不允许把 DeepSeek 的名称、模型名称放在显著位置。

协议 §5.3(3) 还禁止使用"官方合作"一类的说法，所以"内置官方 Agent"不能当卖点。只在开源声明页按 MIT 许可证的要求注明使用了 DeepSeek Harness。

dsh 目前是开发者预览版：会有破坏性变更，也没做过安全审计。因此：

- **云端跑的是 SeekCloud 维护的 dsh 修改版**，不是原版。上游官方版缺的能力直接改源码补上：
  - 逐字流式输出；
  - 中途停止；
  - 插话：把新消息送进正在进行的回合；
  - 向用户出选择题；
  - 彻底移除日志上传。

  dsh 发新版时，先把我们的改动合到新版本上，测试通过后再上线。
- **接入方式**：用 SDK 模式（`dsh --profile sdk`）加官方 TypeScript 客户端。这种模式事件最全，会话 ID 由我们指定，一个进程能跑多个会话。
- **全局关闭 dsh 的会话日志上传**。它默认会把会话日志传给 DeepSeek，和 SeekCloud 的隐私承诺冲突。这份日志不是单独上传的，而是作为 `dsh_session_log` 字段（完整对话，每次最多 8 MiB）夹带在每一次模型请求里。所以要做两件事：
  - 在 `$DSH_HOME/cordis.patch.yml` 里把它关掉；
  - 模型网关剥掉请求里所有 `dsh_*` 字段，以及插件列表、匿名 ID 这类请求头，作为第二道保险。

  另外，用 `DSH_TELEMETRY_DISABLED=1` 关闭反馈遥测。
- **平台层面的差距**（跨会话、定时任务、订阅 PR 动态等）由 SeekCloud 平台自己补上，不等官方。
- 平台和 dsh 之间隔一层适配接口。万一 dsh 不可用，可以换成别的 Agent（首选 OpenCode）。

没做安全审计这件事的风险是可控的。安全边界是沙箱本身，加上"凭据不进沙箱"（ADR 0003）。dsh 就算有漏洞，影响范围也只是这个用户自己的沙箱。

## Considered Options

- **OpenCode**（MIT，TypeScript）：现成的 HTTP 服务模式最完整，DeepSeek 也称它为合作伙伴。没有选它，是因为对标的思路是"厂商在云端跑自家的 Agent"。它是首选的备用方案。
- **Codex CLI**（Apache-2.0，Rust）：事件格式的文档最完整，但它是另一家厂商的 Agent。
- **Claude Code**：排除。许可证禁止做竞争产品，支持地区也不含中国大陆和香港，Anthropic 也不支持把它接到非 Claude 的模型上。

## 改 dsh 的方式（2026-11-18，#17）

原来打算 fork 源码，改完自己构建（公开仓库 `bilixuesheng/seekcloud-dsh`，在本仓库里作为子模块）。动手时发现：

- 上游是一个 200 MB 的单仓库，带原生组件和桌面端。构建要给 TypeScript 8 GB 内存，测试机只有 4 GB，构建不了。
- dsh 是插件化的：每个功能是一个插件，由一层层 patch 配置拼起来。`--patch` 能关掉官方的插件、改它们的配置，也能插进一个放在 patch 文件旁边的本地插件。
- 0.2.2 的 SDK 已经有选择题、批准、计划和权限预设，要改的少了。

所以改成：

- **装官方发布的 npm 包，版本钉在 `apps/host/sandbox/dsh/VERSION`**。通用镜像和 CI 都按它装，升级时改这一个文件，跑一遍测试。
- **能用配置做到的写进基线配置**（`apps/host/sandbox/dsh/baseline.patch.yml`），作为最后一层 `--patch` 叠上。已经做了：
  - 关掉会话日志上传、插件清单上报、遥测和自带的定时提醒；
  - 前台命令的超时；
  - 溢出文件的位置。
- **配置做不到的，写 SeekCloud 自己的 dsh 插件**，和基线配置放在一起，由基线配置插进去。已经有一个：`claude-code-skills.js`，照 Claude Code 读仓库里的 `.claude/skills` 和 `.claude/commands`。插件是本仓库的代码，跟着本仓库的许可证。
- **只有插件也做不到、必须改 dsh 源码的**，才在 `seekcloud-dsh` 里改：每项改动一个小提交，在能构建的机器上构建，再作为子模块接进来。现在还没有这样的改动，`seekcloud-dsh` 暂时空着。
- 逐字流式输出、中途停止、插话这几项，接 SDK 时（#25）逐项核对 0.2.2 是不是已经有了；缺的先看能不能用插件补。

`apps/host/src/dsh-real.test.ts` 用真的 dsh 跑一个回合，模型服务是假的。它检查请求里没有会话日志和插件清单、没有遥测上报，模型看得到 `.claude` 里的技能。CI 的 dsh 那一项按 `VERSION` 装 dsh 跑它，通用镜像的自检也在沙箱里跑一遍同样的检查。

