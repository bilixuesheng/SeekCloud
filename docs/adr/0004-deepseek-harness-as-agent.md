# 用 DeepSeek Harness（dsh）作为沙箱里的 Agent

Claude Code 网页版在云端跑的是 Anthropic 自家的 Claude Code。为了对标这一点，SeekCloud 在沙箱里跑 DeepSeek 官方的 DeepSeek Harness（`dsh`，MIT 许可）。DeepSeek 说过它的模型专门为 dsh 调过。

Agent 的叫法分两处：

- 管理员自己看的界面和导出的文件写 DeepSeek，比如"DeepSeek 已读取""DeepSeek 是 AI，可能会犯错。"；
- 留在 GitHub 上的署名、提交尾注和提交作者的名字写 SeekCloud：`_由 SeekCloud 生成（AI）_`、`Generated-by: SeekCloud (AI)`。这些是公开的，DeepSeek 开放平台协议 §5.3(2) 不允许把 DeepSeek 的名称、模型名称放在显著位置。

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
