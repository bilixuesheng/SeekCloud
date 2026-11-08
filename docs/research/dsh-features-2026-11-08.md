# dsh（DeepSeek Harness）原版功能调研（2026-11-08）

给 SeekCloud 做决策参考：哪些功能 dsh 原版有、怎么配、在 SDK 模式（`dsh --profile sdk`）下能不能用。

文中【推断】后面的"对 SeekCloud"是调研时的建议。SeekCloud 最后怎么定的，以 `docs/roadmap/2026-11-08-handoff.md` 为准（比如插件管理工具定了保持打开）。

## 方法和出处

- **版本**：npm `@deepseek-ai/dsh` 的 `latest` 和 `next` 都是 **0.2.2-rc.1**（2026-11-04 发布），`alpha` 是 0.2.2-alpha.3（2026-11-03）。来源：<https://registry.npmjs.org/@deepseek-ai/dsh>，2026-11-08 查。
- **源码**：GitHub 公开仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT。浅克隆了 tag `dsh-v0.2.2-rc.1`（commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，2026-11-04 15:54 +0800），只当数据读，没有运行里面任何脚本。下文的路径都相对这个 tag 的仓库根目录，链接形如 `https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/<路径>`。
- **文档站**由仓库里的 Markdown 生成（`docs/user/guide/*.md` → <https://deepseek-harness.github.io/deepseek-harness/zh/guide/…>），所以直接引仓库路径。
- **出处标记**：
  - 【文档】：用户文档或包的 README 明文写的；
  - 【配置/代码】：从配置 schema、默认 patch（bundle）或源码看出来的；
  - 【推断】：没有直接证据，是推断的。
- 之前做过一次调研（2026-10-30，没有公开，下文称"旧调研"），读的是 0.2.1-rc.5 和当时的 master。本文以 0.2.2-rc.1 为准，和旧结论不同的地方会标出来。
- **核对过发布包**：另外下载了 npm 上 `@deepseek-ai/dsh`、`dsh-base`、`dsh-sdk-app`、`dsh-web-app` 的 0.2.2-rc.1 压缩包（只解包，不安装、不运行），`dsh-base` 和 `dsh-sdk-app` 的 `cordis.patch.yml`、`dsh-web-app` 的创造模式预设和 git tag 里的逐字节相同，所以下文引的仓库路径就是发布的内容。
- 完整的配置字段表是生成的 `docs/config-catalog.md`；装好后也可以用 `dsh --profile sdk --dump-config`（看合成后的配置）和 `--dump-config-schema`（打印各插件的 JSON Schema）。【文档】`apps/cli/README.md`。

## 结论速览

1. **提供方**：能配多个提供方（原生 DeepSeek API key 路由、DeepSeek 账号路由、pi-ai 的任意 OpenAI Chat/OpenAI Responses/Anthropic Messages 兼容路由），但**每个路由只有一个地址和一个 key**。网页和 ACP 能在会话中途换模型，SDK 的路由是整个进程固定的，要重启进程再 `session/resume`。出错时只在**同一路由内重试**（默认 5 次指数退避，可设无限重试），**没有切到别的提供方的回退，也没有熔断**。
2. **用量和余额**：token 用量（含缓存读写、思考 token）每一步都有，SDK 能拿到；**dsh 不算钱**。**余额只有登录 DeepSeek 账号（浏览器 OAuth）才显示**，走开放平台的接口；API key 路由不查余额。SDK 里登录不了（没有 Web 服务），也没有查余额的方法。
3. **SDK 里用不了的**：网页界面上的东西（轨迹视图、统计页、模型设置页、插件页和"发现"页、语音输入、Auto review、会话内换模型）、Agent 预设（标准/PTC/极简/创造四种模式）、DeepSeek 账号登录和余额、定时提醒的"新建会话"投递、取消回合。详见下表。

### SDK 模式（`dsh --profile sdk`，0.2.2-rc.1）能不能用

| 功能 | SDK | 说明（详见对应小节） |
|---|---|---|
| 多提供方、自定义兼容地址（patch 配置） | 能 | 1.2 |
| 会话中途换模型 | 不能直接 | 进程级路由，不能再次 `initialize`；重启 + `session/resume`（1.3） |
| 同路由重试 | 能 | `llm/retry` 事件也会推（1.4） |
| 跨提供方回退、熔断 | dsh 本身就没有 | 1.4 |
| token 用量 | 能 | `session.event` 里的 `assistant/message.usage`（2.1） |
| 花费 | dsh 本身就没有 | 2.2 |
| DeepSeek 账号登录、余额 | 不能 | 浏览器登录要 Web 服务（2.3） |
| 插件管理工具 `plugin_manager` | 能（默认开） | 没有 HMR，改了要重启；建议关掉（3.2） |
| 插件市场"发现"页、`plugin_market` | 不能 | 网页标签页 + 只挂在网页创造模式里（3.3） |
| MCP | 能 | patch 配置，进程级（3.4） |
| 标准/PTC/极简/创造模式 | 不能 | 预设只在网页 profile；SDK 用 base 工具树，PTC 用叠加层，另有 `sdk-minimal`（4） |
| 轨迹视图 | 不能（界面） | 数据都在 `session.event`，可以自己做（5.1） |
| `/goal` | 能 | `session/query`（5.2） |
| `/plan` 和计划审批 | 能 | 要 `capabilities.userQuestions`（5.3） |
| `/permission` 和审批 | 能 | 要 `approvalRequests: true`（5.4） |
| Auto review | 不能 | 只有网页和 headless（5.4） |
| 定时提醒 | 部分 | 只能投到现有会话，进程停了就不触发（5.5） |
| 语音输入 | 不能 | 网页组件（5.6） |
| 子 Agent | 能 | 进程内，有通知（5.7） |
| 会话日志上传、遥测 | 默认开，能关 | patch + 环境变量（5.8） |
| 会话恢复 | 能 | 6 |
| 取消回合 | 不能 | 只能杀进程（6） |

---

## 0. 先说 SDK 模式到底装了什么（影响下面每一项）

- `dsh --profile sdk` 的组合 = `dsh-base` 的 patch + `dsh-sdk-app` 的 patch + `$DSH_HOME/profiles/sdk/cordis.patch.yml` + `$DSH_HOME/cordis.patch.yml` + 命令行 `--patch` 叠加层，后面的按行 `id` 覆盖前面的，**覆盖的是整行 `config`，不是合并字段**。【文档】`apps/cli/README.md`「Profiles」、`apps/cli/reference/README.md`「Profile boot」。
- SDK patch（`packages/bundle/sdk-app/cordis.patch.yml`）在 base 之上：【配置/代码】
  - 关掉 `session-title-llm`（不自动起标题）、关掉 `hmr`（改配置要重启）；
  - **打开** `tool-plugin-manager`（Agent 可调用的插件管理工具）；
  - 加了 `schedule`（注入 `sdkSessionActivation`）、`tool-schedule`、`time-context`、`tool-ask-user`、`present`、`workspace`、`connection`、`file-upload`、文件引用等；
  - **不起 Web 服务**（注释原文："Share native desktop tools and model context without starting a Web server"）。
- 和 0.2.1-rc.5 的区别（旧调研以为 SDK 没有这些）：0.2.2-rc.1 的 SDK 协议已经有 `session/query`（`/compact`、`/permission <预设>`、`/plan`、`/goal`）、`approval/request`（`initialize.approvalRequests: true`）、`user-question/ask`（`initialize.capabilities.userQuestions: true`），定时提醒也能在 SDK 里用。【文档】`packages/sdk/protocol/README.md`、`packages/sdk/server/README.md`。
- 仍然没有：取消/中止回合、关闭会话的方法，"a client abandons a turn by closing the runtime process"；没有协议版本协商（`serverInfo.version` 还是 `0.0.1`）。【文档】`packages/sdk/protocol/README.md`「Known Limitations」。

---

## 1. 模型提供方和上游

### 1.1 有哪几种提供方（路由）

base 里同时挂着三个模型适配器，每个注册一个或多个"provider 路由"，请求按 `provider` 名字选路由：【配置/代码】`packages/bundle/base/cordis.patch.yml`

| 路由名 | 插件（行 id） | 协议 | 凭据 |
|---|---|---|---|
| `deepseek-official` | `@deepseek-ai/dsh-llm-deepseek-api-key`（`llm-deepseek`） | 只有 Anthropic Messages（`/v1/messages`、`/v1/files`） | API key，`x-api-key` 头，默认读 `DEEPSEEK_API_KEY` |
| `deepseek-account` | `@deepseek-ai/dsh-llm-deepseek-account`（`llm-deepseek-account`） | 同上 | 登录 DeepSeek 账号得到的令牌，`x-dsh-auth-token` 头 |
| 任意名字（`openai`、`anthropic`、`moonshotai`、`zai`、自定义网关…） | `@deepseek-ai/dsh-llm-pi-ai`（`llm-pi-ai`），默认"休眠"，没配 `providers` 就零路由 | `openai-completions`、`openai-responses`、`anthropic-messages` 三选一 | `apiKeyEnv`（凭据引用），或 pi-ai 自带的 OAuth 登录 |

- 新会话默认 `provider: deepseek-official`、`model: deepseek-flash`（行 `agent-default-model`）。【配置/代码】base patch。
- 两个 DeepSeek 路由**互不回退**："Neither route falls back to the other"。【文档】`packages/llm/llm-deepseek/README.md`「Account credentials」。

### 1.2 能不能配多个提供方、多个地址和 key

**能配多个提供方，但每个路由只有一个 `baseURL` 和一个凭据引用。** 想要"同一家两个地址/两个 key"，就配成两个不同名字的路由。【文档】`docs/user/guide/providers.md`："A provider speaks one protocol, so a gateway that serves two needs two providers."

- 原生 DeepSeek（`llm-deepseek` 行）：字段 `baseURL`（优先级：显式配置 → `$DEEPSEEK_BASE_URL` → `https://api.deepseek.com/anthropic`）、`apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）、`reasoningEffort`（`off|low|high|max`，默认 `high`）、`thinking`、`maxTokens`（默认 256,000）、`models`、`streamIdleTimeoutMs`（默认 300,000）、`retryPolicy`。【文档】`packages/llm/llm-deepseek/README.md`「Minimal configuration」表。
  - 用非官方 `baseURL` 时不请求 `GET /models`，用配置里的或内置的模型表（`deepseek-flash` 能看图、`deepseek-v4-pro`）。用官方地址且 `models` 没改时，每 10 分钟拉一次官方 `GET https://api.deepseek.com/models`。【文档】`packages/llm/llm-deepseek-api-key/README.md`。
  - 只支持 Messages，**没有 `protocol` 字段**，写了会报 `protocol is not configurable`。【文档】同上 llm-deepseek README「Failures and recovery」。
- 自定义 OpenAI 或 Anthropic 兼容地址（`llm-pi-ai` 行），例子：【文档】`docs/user/guide/providers.md`、`packages/llm/llm-pi-ai/README.md`

  ```yaml
  - id: llm-pi-ai
    config:
      providers:
        my-gateway:              # 路由名，永久，不能改名
          displayName: My Gateway
          apiKeyEnv: GATEWAY_API_KEY
          api: openai-completions  # 或 openai-responses / anthropic-messages
          baseURL: https://gateway.example/v1
          compat:
            thinkingFormat: deepseek        # DeepSeek V4 走 OpenAI 兼容网关时要加
            supportsDeveloperRole: false    # 很多网关不认 developer 角色
            maxTokensField: max_tokens
          retryPolicy: { mode: normal, maxRetries: 3 }
          models:
            - id: deepseek-v4-pro
              reasoningEfforts: { off: , high: high, max: max }
  ```
  - 网页版在"设置 → 模型 → 添加模型提供方 → 自定义模型 API"里填，写进当前 profile 的 `cordis.patch.yml`；key 写进 `$DSH_HOME/.credentials.yaml`，配置里只留引用。【文档】providers.md。
  - 凭据查找顺序：继承的环境变量 → `$DSH_HOME/.credentials.yaml` → 启动目录的 `.env` → `$DSH_HOME/.env`。【文档】`apps/cli/reference/README.md`「Shared deployment behavior」。（`packages/credentials/README.md` 又说存储的值优先于 `DEEPSEEK_API_KEY=… dsh`，两处说法不完全一致，以实测为准。）
  - 注意：旧调研说过，pi-ai 走 OpenAI Chat 时会不会把 DeepSeek 的 `reasoning_content` 回传，文档没写明；`compat.thinkingFormat: deepseek` 只说明会发 `thinking: {type: enabled|disabled}`。【推断】接 DeepSeek 仍然建议走原生 `deepseek-official` 路由（Anthropic 兼容），把 `DEEPSEEK_BASE_URL` 指向我们的网关。
- 联网搜索是另一条单独的 Messages 请求，读 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_SEARCH_BASE_URL`，和模型路由的地址分开配。【文档/配置】base patch 里 `web-search-deepseek`、`web-deepseek-api` 两行的注释；`apps/cli/reference/README.md`。

**SDK 模式**：上面所有 patch 配置在 SDK 里都能用（`$DSH_HOME/profiles/sdk/cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml` 或 `--patch`）。但 `initialize {provider, model, reasoningEffort?, maxTokens?}` 是**整个进程**的：这个进程里 SDK 建的所有 Agent（包括子 Agent）都用这一条路由。【文档】`packages/sdk/protocol/src/types.ts` 的 `InitializeParams` 注释 "Provider route every SDK-created agent runs on"；`packages/sdk/server/README.md`「Wiring」：已注册的适配器优先，未被认领的 `deepseek-official` 会自动挂 DeepSeek 适配器，"any other unowned provider fails initialization"。SDK 模式没有网页的模型设置页，只能直接写 patch。

### 1.3 能不能在会话里切换

- **网页版能**：`/model` 弹层和输入框旁的模型按钮，"A complete selection applies to the next request; a running step keeps the model and effort it started with"。【文档】`packages/client/ui-model-selection/README.md`。
- **ACP 能**：`session/set_config_option` 改 `model` 和 `reasoning_effort`。【文档】`packages/acp/acp/README.md` 第 70 行（"A serialized update to the advertised `model` or `reasoning_effort`"）。
- **SDK 不能直接切**：同一进程不能再 `initialize` 一次（`packages/sdk/server/src/server.ts` 第 94 行注释 "reinitialization is unsupported"）；`/model` 也不是 SDK 命令（"`/model` remain[s] ordinary prompts"，会被当成普通文字发给模型）。办法是关掉进程、用新的 `initialize` 重启、再 `session/resume`：resume 会"recording the initialized model route as the Session selection"，并写一条新的 `session.event`。【文档】`packages/sdk/server/README.md`「command-input」和 `session/resume` 段。

### 1.4 出错时会不会重试、回退、熔断

- **重试：有，同一条路由内。** `@deepseek-ai/dsh-llm-retry`（base 默认挂）执行各路由自己的 `retryPolicy`。【文档】`packages/llm/llm-retry/README.md`
  - 默认 `normal`：对 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 重试 **5 次**，指数退避 500 ms 到 10 s，10% 抖动；提供方给了合法的 `Retry-After` 就照它等。
  - `always`：所有失败无限重试，直到成功、取消或卸载插件，**包括认证、额度、请求无效这类永久错误**（文档在"Known Limitations"里明说）。
  - 每次重试都是一次新的计费请求；重试前先写 `llm/retry`、开始时写 `llm/retry-started` 两个事件进会话日志（模型看不到），所以 SDK 的 `session.event` 能看到。
  - 只在 Agent 回合里重试；插件直接调 `ctx.llm.stream()`（比如起标题、压缩摘要）只试一次。
  - 配置写在路由上，比如：
    ```yaml
    - id: llm-deepseek
      name: '@deepseek-ai/dsh-llm-deepseek-api-key'
      config:
        retryPolicy:
          mode: normal        # 或 always
          maxRetries: 3
          backoff: { initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0.2 }
    ```
    字段：`mode`（`normal`/`always`）、`maxRetries`（默认 5）、`retryableCodes`（默认上面五个）、`backoff.initialDelayMs`（500）、`maxDelayMs`（10000）、`jitterRatio`（0.1）。【配置/代码】`packages/llm/llm/src/retry-policy.ts`。`llm-pi-ai` 是每个 provider 各配一个。
- **回退到别的提供方/模型：没有。** 在 `packages`、`apps`、`docs` 里搜 failover、fallback provider、circuit breaker，只有 pi-ai 目录里一个 `allowedFallbackModels: 'withhold'`（pi-ai 自带的能力，不是可配开关）。`dsh-llm` 文档写明"No retry execution, caching, or rate limiting ships in this service"，每次 stream 只有一次尝试。【配置/代码】grep 结果；【文档】`packages/llm/llm/README.md`「Known Limitations」。
- **熔断：没有。**【配置/代码】同上 grep。
- 错误码是稳定的：`AUTH`（401/403）、`QUOTA`、`ACCOUNT_QUOTA`（只给登录账号的余额不足，网页会弹"充值"）、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`、`TRANSPORT`、`TIMEOUT`、`EMPTY_RESPONSE`、`MISSING_CREDENTIAL`、`CLIENT_UPGRADE_REQUIRED` 等。【文档】`packages/llm/llm/README.md`「Failures and recovery」、`packages/llm/llm-deepseek/README.md`、`packages/llm/llm-deepseek-account/README.md`。
- 【推断】对 SeekCloud 的意义：多线路切换、熔断要在我们的模型网关里做；dsh 侧只把 `retryPolicy` 设成 `normal`（别用 `always`，否则额度用完会无限重试），网关返回 429/5xx 时带 `Retry-After`。

---

## 2. 用量和余额

### 2.1 token 用量：有，从会话日志算

- 每一步的 `assistant/message` 事件带 `usage {inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}`，是提供方报回来的数。SDK 的 `session.event` 原样转发。【文档】旧调研引的 `docs/subsystems/llm-streaming.md`；`packages/sdk/protocol/README.md`（`session.event` 是每个持久事件）。
- `@deepseek-ai/dsh-token-meter`（base 默认挂）从日志重放出 `tokenUsage`（整场的未命中缓存输入、输出、缓存读、缓存写）、`contextPressure`（最近一次提示的大小、下一次大约多大、上下文窗口）、`contextBreakdown`（系统、工具、消息各占多少，启发式估算），重试的每次尝试分别计入。【文档】`packages/llm/token-meter/README.md`。
- 网页版：完成的回合下面有可展开的用量行；输入框下面有"输出速度、缓存命中率"等统计；"设置 → 通用 → 性能与用量"可选 `detailed`（默认）/`compact`。【文档】`packages/client/ui-chat/README.md`「Turn token usage」。实验插件 `dsh-experimental-client-ui-stats` 加一个"统计"标签页（每回合/每步的上下文、缓存命中、首 token 延迟、模型和工具耗时）。【文档】`packages/experimental/client-ui-stats/README.md`。
- **SDK 模式**：token 数在 `session.event` 里都有，界面要我们自己做；`tokenMeter` 的投影是网页客户端用的，SDK 协议不转发。【推断】

### 2.2 花费（钱）：dsh 自己不算

- 在 `packages/client` 的 tsx 里搜 cost/price/pricing，没有按价格算钱的界面；token-meter 的 "price" 指的是 token 数估算，文档说要精确计费得用提供方的分词器。【配置/代码】grep；【文档】token-meter README "reach for a provider tokenizer when a deployment needs exact billing-grade counts"。
- 登录账号后，"用量"和"充值"是打开 DeepSeek 开放平台自己的页面：`usageUrl = <platformOrigin>/usage`，`topUpUrl = <platformOrigin>/top_up`（`platformOrigin` 默认 `https://platform.deepseek.com`）。桌面版嵌在原生视图里，网页版开新标签页。【配置/代码】`packages/credentials/deepseek-account-platform/src/index.ts` 第 53、187 行；【文档】`packages/client/ui-settings-account/README.md`。

### 2.3 DeepSeek 账户余额：**只有登录 DeepSeek 账号才有，API key 查不到**

- 余额来自账号登录：`getBalance` 用登录得到的令牌（`x-dsh-auth-token`）请求开放平台 `GET /api/v0/users/get_user_summary`，取 `normal_wallets`（充值余额）和 `bonus_wallets`（赠送余额）的币种和金额字符串；个人信息走 `GET /auth-api/v0/users/current`；赠金通知走 `get_unnotified_bonuses` / `ack_bonus_notified`。默认超时 30 s，失败不显示余额、也不当成 0。【文档】`packages/credentials/deepseek-account-platform/README.md`。
- 登录方式：系统浏览器里 OAuth（PKCE S256），回调 `/oauth/callback` 挂在 dsh 自己的 Web 服务上；**只支持本机或 SSH 本地端口转发（localhost/127.0.0.1/[::1]），不支持非本机的反向代理**；令牌没有过期和刷新流程。【文档】同上「Known Limitations」。
- API key 路由（`deepseek-official`）**没有查余额**：在源码里搜 `user/balance`（DeepSeek 公开 API 的余额接口）零结果，搜 balance 只在账号相关的包里出现。【配置/代码】grep。
- 余额显示在"设置 → 账户"卡片；余额不足时 `ACCOUNT_QUOTA` 弹"取消 / 充值"。【文档】`packages/client/ui-settings-account/README.md`。
- **SDK 模式**：base 里挂着账号插件，但 SDK 不起 Web 服务，而浏览器登录要 `webServer`（源码 `deepseek-account-platform/src/index.ts` 第 523–524 行：没有 webServer 就抛 `PlatformAuthError('protocol')`），所以**在 SDK 里登录不了**；SDK 协议也没有查余额、查账号的方法。【配置/代码】【推断：如果先用 `dsh web` 在同一个 `$DSH_HOME` 登录过，SDK 用 `provider: deepseek-account` 也许能复用存下的令牌，未验证】对 SeekCloud（只用 API key、走自己的网关）来说，这条路本来就用不上。

---

## 3. 插件和插件市场

### 3.1 插件的格式

- dsh 里"一切都是插件"：插件是导出 `apply(ctx)` 的 JS/TS 模块，通过 patch 里的一行装进组合。**能装的单位叫 bundle**：一个 npm 包，`package.json` 里写 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，再带一个 `cordis.patch.yml`（插入或覆盖若干行）。版本兼容用 `engines.dsh` 声明，没写就看它对 `@deepseek-ai/dsh*` 的 peer 依赖。【文档】`docs/user/develop/basic/publish.md`。
- 每个 profile 是 `$DSH_HOME/profiles/<名字>/`，里面 `package.json`（pnpm 管的依赖 + `dsh.profile.bundles` 顺序表）和 `cordis.patch.yml`（用户自己的一层）。【文档】同上、`apps/cli/README.md`。
- 安装：`dsh plugin --profile <名字> add <npm 包名 | git 地址 | tarball | 绝对路径>`（就是在 profile 目录里转发 pnpm）。默认 `fallbackRegistries: ['https://registry.npmmirror.com/']`，GitHub 连不上时提示换国内镜像。装进来的代码**在沙箱外、进程内**运行。【文档】`packages/boot/plugin-manager/README.md`；`apps/cli/reference/README.md`。
- 兼容豁免：`dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <ver> --accept-risk`，记在 profile 的 `compatibility.json`。【文档】plugin-manager README「Version compatibility and exemptions」。

### 3.2 已安装、内置、实验性插件（网页"插件"页）

- 侧栏 **Plugins** 页：【文档】`packages/client/ui-plugin-manager/README.md`
  - **Built-in plugin settings**：官方插件的配置页（子 Agent、联网搜索、Agent 循环、Shell）；
  - **Experimental plugins**：随安装一起带、默认关的官方可选 bundle，旁边 **More** 看全部（Codex、Claude Code 子 Agent 排最后）；Ralph 循环、会话搜索、LiveShare 默认不列出，输入包名才出来；
  - **Installed plugins**：profile 里其他（第三方）bundle；
  - **Add plugin**：装第三方插件，或"让 Agent 创建插件"（进入创造模式）。
  - "设置 → 内置插件"是只读清单。
- 实验性 bundle 的完整清单在 `packages/experimental/README.md`「Packages」表（"Experimental" = 不承诺产品支持，可能改或撤回）。和 SeekCloud 关系大的：`plugin-market-bundle`（插件市场）、`voice-input-bundle`、`agent-team-profile`（Agent 团队）、`client-ui-stats`（统计页）、`auto-review`、`hooks-claude-code` / `hooks-codex`、`webhook` / `webhook-github`、`forge-bundle`（PR 和 worktree 面板）、`liveshare`（会话分享）、`session-titles-bundle`、`cot-translation-bundle`（思考过程翻译）、`terminal-bundle`、`tool-worktree`、`session-search`、`ralph-bundle`、`claude-code-mods`、`subagent-oar`（外部编程 Agent 当子 Agent）、`cua-*` / `browser-use-*`（电脑和浏览器操作）、`inspector-profile`。
- Agent 可调用的 `plugin_manager` 工具：在标准模式和创造模式里打开；**完整 SDK profile 也打开**（`sdk-app` patch 里 `tool-plugin-manager: disabled: false`）。SDK 没有 HMR，所以改了会返回 `restart-required`/`no-hmr`，重启后生效。每次调用都要 `danger-full-access` 或单次审批。【文档】plugin-manager README「Use this package」；【配置/代码】`packages/bundle/sdk-app/cordis.patch.yml`。
  - 【推断】对 SeekCloud：Agent 能用这个工具往 profile 里装任意 npm/git 包并在宿主进程里跑，**云端多用户场景下要在 SDK patch 里把 `tool-plugin-manager` 关掉**（`- id: tool-plugin-manager` + `disabled: true`），由我们自己管插件。

### 3.3 自定义插件市场（"发现"页）

- 实验 bundle **Custom plugin indexes**（`@deepseek-ai/dsh-experimental-plugin-market-bundle`），默认关。打开后插件页多一个 **Discover** 标签，创造模式多一个只读的 `plugin_market` 工具。【文档】`docs/user/guide/plugin-market.md`。
- **dsh 不内置任何索引源**，要自己"添加索引源"填一个 JSON 地址（http/https，不许带用户名密码和 `#`），每个 profile 各自一份；配置字段 `plugin-market` 行的 `indexes`（默认 `[]`），还有 `fetchTimeoutMs` 15 s、`maxBytes` 128 MiB、`cacheTtlMs` 10 分钟等。【文档】`packages/boot/plugin-market/README.md`。
- 索引格式：`{ "format": 1, "title", "plugins": [{ name, title, description, icon, author, homepage, repository, metadata, versions: [{ version, publishTimestamp, source: {type: npm, registry?} | {type: git, url, commit(40位), path?}, engines.dsh }] }] }`。安装前弹确认框显示来源；装的时候走普通插件安装的兼容检查。仓库里有参考生成器 `apps/plugin-market-generator`（`pnpm --filter @deepseek-ai/dsh-plugin-market-generator start --input plugins.txt --output site/index.json`），只下载不执行。【文档】plugin-market.md「Index format reference」「Generate an index」。
- **SDK 模式**：bundle 里两行，`plugin-market`（宿主服务，要有 profileContext）和 `ui-plugin-market`（网页标签）；SDK 没有网页，`plugin_market` 工具只挂在网页的创造模式预设里。所以 **SDK 里用不了"发现"页**；要的话得自己在 SDK patch 里插入 `@deepseek-ai/dsh-plugin-market/tools` 这一行。【配置/代码】`packages/experimental/plugin-market-bundle/cordis.patch.yml`、`packages/bundle/web-app/presets/cordis.patch.yml`；【推断】SDK 里手动插入能不能用未验证。

### 3.4 MCP 支持

- `@deepseek-ai/dsh-mcp-client`：每个服务一行 patch，`transport: stdio | streamable-http`，`serverName`（`[A-Za-z0-9_-]{1,32}`），stdio 用 `command/args/env/cwd`，HTTP 用 `url/headers`；`toolCallTimeoutMs` 默认 60 s，自动重连（500 ms 起翻倍到 30 s，最多 10 次），`failOnStartupError` 默认 false。工具名 `mcp__<server>__<tool>`。**没有任何默认开的 MCP 服务**；不支持 SSE、不支持 MCP prompt 模板；服务的 instructions 会以原文拼进系统提示词（上限 32 KiB）。MCP 资源由 base 里的 `mcp-resources` 统一读。【文档】`packages/mcp/mcp-client/README.md`、`apps/cli/reference/README.md`。
- 没有网页上加 MCP 的表单；示例在 `apps/cli/config/examples/mcp-memory/*.cordis.yml`，用 `--patch` 加载。【文档】`docs/user/guide/mcp-memory.md`。
- **SDK 模式能用**：`initialize` 会等插件树稳定、MCP 初次发现完再回复。SDK 不能按会话传 MCP 服务（ACP 的 `session/new` 能）。【文档】`packages/sdk/server/README.md`「What SDK clients can do」。

---

## 4. 几种模式（Agent 预设）

dsh 把"模式"做成 **Agent 预设**（`@deepseek-ai/dsh-agent-preset`，每个预设是一份子插件清单），由 `agent-preset-registry` 选择，**只在网页 profile 里有**（`packages/bundle/web-app/package.json` 的 `dsh.bundle.patch` 依次加载 `presets/standard|ptc|minimal|cordis.patch.yml`，默认 `standard`）。【配置/代码】

| 模式（中文界面名） | 预设 id | 界面说明（中文 locale 原文） | 和标准模式比，装了什么 |
|---|---|---|---|
| 标准模式 | `standard` | "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。" | 基准：bash/pwsh、文件读写编辑、grep/glob、后台任务、定时提醒、Skills、`/goal`、计划模式、压缩、子 Agent（spawn/fork）、workflow、`ask_user_question`、todo、联网搜索和抓取、`present`、插件管理工具（有 profile 时） |
| PTC 模式 | `ptc` | "包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。" | 多 `tool-executor-ptc`：模型用 `run_code` 写 TypeScript 程序调用生成的工具 SDK；**关掉了 workflow 和插件管理工具** |
| 极简模式 | `minimal` | "Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。" | 只有固定提示词 "You are a helpful software engineer assistant."、持久 Shell、`read_image`、压缩；不加载 Skills、计划、运行时上下文、AGENTS.md |
| 创造模式 | `cordis` | "用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。" | 标准模式的工具 + `tool-cordis`（只读查看宿主和客户端运行时 API）+ 插件开发 Skills（`agent-experience`、`cordis-plugin-development`、`editing-cordis-compositions`、`cordis-composition-reference`）+ `plugin_market`（插件市场 bundle 打开时） |

出处：【配置/代码】`packages/bundle/web-app/presets/*.patch.yml`（用脚本列出各预设的插件行比对）；【文档】`packages/client/ui-agent-preset/src/client/locales.ts`、`guide-locales.ts`（中文名和说明）、`packages/preset/agent-preset/README.md`、`packages/extensions/tool-cordis/README.md`。

- 用户说的"代码模式"在 rc.1 里没有这个名字；最接近的是 **PTC 模式**（Programmatic Tool Calling，统计插件里叫 "Code-Mode"）。【推断】
- **怎么切换**：网页新建任务时在模式选择器里选；"设置 → 通用 → Coding Tools"关掉时只给标准、创造和自定义，打开才有 PTC 和极简。**会话开始后不能换模式**："Existing sessions keep their selected mode; New Session uses the current default"，对已开始的会话选择会返回 `unchanged`。【文档】`packages/client/ui-agent-preset/README.md`「Use this package」。
- 自定义模式：在创造模式里让 Agent 写一个预设 bundle；设置页每张模式卡片可"查看配置"（只读 YAML）。【文档】同上。
- **SDK 模式**：**没有预设，也就没有这四种模式**。SDK 用 base 的工具树（大致等于标准模式，加上 `sdk-app` 里的 schedule、ask-user、present、插件管理）；PTC 要用 `--patch apps/cli/config/examples/ptc.yml` 一类的叠加层；`dsh --profile sdk-minimal` 是独立的精简树（固定 `danger-full-access`，不挂审批和权限服务）。创造模式的 `tool-cordis` 需要 Cordis host runner 提供检查注册表、浏览器查询要连着页面，SDK 里没有。【文档】`apps/cli/reference/README.md`（"Web, headless, and SDK inherit native tool execution from the base bundle; use a PTC overlay to select PTC"、sdk-minimal 那段）；`packages/extensions/tool-cordis/README.md`。

---

## 5. 轨迹视图、目标、计划、权限、定时提醒、语音、子 Agent、日志和遥测

### 5.1 轨迹视图（Trajectory）

- 网页对话区的一个标签页（和"聊天"并列），网页 profile **默认挂**（`web-app` patch 里 `ui-trajectory` 行）。按回合分组列出 User、Assistant、Tool、嵌套子调用、压缩记录，标出回合和步骤边界；点一条记录打开检查器看 token 用量、耗时、输入、输出、时间线、图片和附件；`run_code` 显示带高亮的源码；请求在等待、流式、重试时显示进行中，重试次数和最后一次错误保留。长历史按需分页加载。【文档】`packages/client/ui-trajectory/README.md`；【配置/代码】`packages/bundle/web-app/cordis.patch.yml` 第 464 行。
- 实验插件 `client-ui-stats` 另加"统计"标签（见 2.1）。
- **SDK 模式**：轨迹视图是网页客户端组件，SDK 里没有；但它读的全是会话日志事件（`turn/start`、`step/*`、`assistant/message`、`tool/*`、`llm/retry*` 等），这些 SDK 的 `session.event` 都会推，**我们可以照着自己做一个**。【推断】

### 5.2 目标（`/goal`）

- 一个会话最多一个"当前目标"，跨回合、跨恢复、跨 fork、跨重启保存；状态 `active / paused / blocked / complete`；Agent 空闲时由 `goal-round-driver` 自动在同一会话里继续下一轮，轮数上限默认 256（`dsh-goal` 的 `defaultMaxGoalRounds`），用完记为 blocked。【文档】`packages/goal/goal/README.md`、`goal-round-driver/README.md`。
- 用户命令：`/goal <目标>`、`/goal`（看状态）、`/goal edit <目标>`、`/goal pause`、`/goal resume`、`/goal clear`；中文别名 `/目标`。模型工具：`create_goal`、`get_goal`、`update_goal`。【文档】`packages/goal/command-goal/README.md`；`docs/tool-catalog.md`。
- "继续"的许可是**进程内**的，不持久："continuation permission remains process-local rather than durable"；恢复会话后要 `/goal resume` 重新启动自动轮次。【文档】goal README Summary；`packages/sdk/server/README.md`。
- **SDK 模式能用**：base 里挂了 `goal`、`goal-round-driver`、`command-goal`、`tool-goal`；`session/query` 认 `/goal …`，高层 `run()` 会一直等到目标结束（完成返回 `completed`，暂停或清除返回 `aborted`）。【文档】`packages/sdk/server/README.md`「command-input」。
  - 【推断】对 SeekCloud：容器休眠时自动轮次会停；唤醒后要我们代发 `/goal resume`。

### 5.3 计划模式

- `/plan`（可带说明和附件）进入，`/plan off` 退出；模型写完计划调 `exit_plan_mode`，用户选"批准"或"继续计划"。**只是提示词约束，所有工具照样能调**，要真限制得靠沙箱和审批。中文别名 `/计划`。状态在恢复和 fork 后保留。【文档】`packages/plan/plan-mode/README.md`；提示词原文在 base patch 的 `plan-mode.section`。
- 计划审批走"用户提问"通道。**SDK 模式能用**：`initialize.capabilities.userQuestions: true` 后，审批以 `user-question/ask` 发给我们；`/plan` 走 `session/query`。注意："Question waits are process-local — question request ids are not durable handles for replying after runtime restart"，进程重启后等着的问题就丢了。【文档】`packages/sdk/protocol/README.md`。

### 5.4 权限预设

- base 里三档：`read-only`（只读 + ask）、`workspace-write`（默认，工作区可写 + ask）、`danger-full-access`（全开 + never）。`DSH_PERMISSION_MODE` 改进程默认值；用户用 `/permission <预设>`（中文 `/权限`）切换，只改当前会话；`permission.defaultPreset` 设置项只影响以后的新会话。【文档】`packages/interaction/permission-presets/README.md`；【配置/代码】base patch 的 `sandbox-policy`、`approval`、`permission` 行。
- 实验 `auto-review`：每次工具调用前让同一个模型先审一遍，允许就以全权限执行，拒绝就问用户；默认关，会多花 token，"can allow unsafe actions"。只在网页（会话权限选择器）和 headless 里。【文档】`packages/experimental/auto-review/README.md`。
- `workspace-write` 要 bwrap、Landlock 或 Seatbelt，否则 `SANDBOX_UNAVAILABLE` 拒绝执行（`packages/sandbox/sandbox-local/README.md` 第 12、57 行，"commands never silently run without confinement"）；而且只限制写和 bash，**读和网络不限制**。【文档】`apps/cli/reference/README.md` 第 131 行。
- **SDK 模式能用**：`/permission <预设>` 走 `session/query`；`initialize.approvalRequests: true` 后需要审批的操作以 `approval/request` 发给我们，回复 `allowed-once | rejected | cancelled`，传输断开就按拒绝处理。0.2.1-rc.5 里还没有这个，那时只能用 `danger-full-access`。【文档】`packages/sdk/protocol/README.md`、`packages/sdk/server/README.md`。

### 5.5 定时提醒（Schedule）

- 模型工具 `schedule_create / schedule_list / schedule_view / schedule_edit`，用 RFC 5545 重复规则 + IANA 时区；投递目标三种：`session`（现有会话）、`new_once`（默认，第一次投递时新建一个会话，之后一直用它）、`new`（每次投递新建会话，最小间隔默认 1 分钟）。网页有"自动化任务"页，能手动建、改、立即运行、暂停、删除、看投递记录。子 Agent 调不了这些工具。【文档】`docs/user/guide/schedule.md`；`docs/tool-catalog.md`。
- **只在宿主进程运行时触发**："Closing the Host stops scheduling until it starts again"；重启后补发过期的单次任务和每个重复任务最近错过的一次。【文档】schedule.md「Timing and delivery reference」。
- **SDK 模式部分能用**（0.2.1-rc.5 里完全不能用，现在能了）：`sdk-app` patch 挂了 `schedule`（注入 `sdkSessionActivation`）和 `tool-schedule`；到期的提醒等 SDK `initialize` 成功后再恢复会话投递。**但 SDK 组合没有"建会话"的提供者，所以 `new` 和 `new_once` 目标会被拒绝（`invalid_rule`），只能投到现有会话。**【文档】`docs/subsystems/schedule.md` 第 84 行；`packages/sdk/server/README.md`。
  - 【推断】对 SeekCloud：dsh 的定时只在进程活着时有效、只能投回原会话，和 Claude Code 的"云端定时任务每次新开会话"不一样；仍然建议在平台侧做调度，把 SDK 里的 `tool-schedule` 关掉，换成我们自己的 MCP 工具，免得模型建了一个进程一停就不触发的提醒。

### 5.6 语音输入

- 实验 bundle `voice-input-bundle`（默认关）：浏览器麦克风采集 → 宿主上的本地 SenseVoiceSmall ONNX + Silero VAD（`sherpa-onnx`，宿主 CPU 识别，模型存 `$DSH_HOME/speech-to-text/sensevoice`）。不调用云端识别服务。【文档】`packages/experimental/voice-input-bundle/README.md`、`speech-to-text-sensevoice/README.md`；【配置/代码】`voice-input-bundle/cordis.patch.yml`。
- **SDK 模式用不了**：它的入口是网页组件 `client-ui-voice-input` 加一个 Remote 接口 `api-speech-to-text`，SDK 没有网页也没有 Remote。【推断】SeekCloud 要做语音，可以在我们自己的前端用浏览器或手机系统的识别，和 dsh 无关。

### 5.7 子 Agent

- base 默认挂：`subagent`（spawn，新上下文）、`subagent_fork`（继承父对话，为 KV 缓存复用不带模型参数）、`list_subagent_models`、`send_message`、`interrupt_agent`、`list_agents`、`workflow`（PTC 脚本编排多个子 Agent）。每次委派立刻返回子 id，子 Agent 都是异步的；本地子 Agent 能接后续消息和恢复。【文档】`docs/tool-catalog.md`；`packages/subagent/tool-subagent/README.md`。
- 限制：`maxDepth` 默认 1（`0` 禁止委派），`maxActiveSubagents` 默认 8（每棵树），网页"插件 → 子 Agent"页能改。【文档】`packages/subagent/subagent/README.md`、`tool-subagent/README.md`。
- 还能接外部 Agent 当子 Agent：`subagent-codex`、`subagent-claude-code`、`subagent-acp`、`subagent-dsh-sdk`（另起一个 dsh SDK 进程）、实验 `subagent-oar`。实验 `agent-team-profile`：有名字的队友、私信、共享任务板。【文档】`packages/subagent/*/README.md`、`packages/experimental/README.md`。
- 没找到"仓库里放 Agent 定义文件"（像 `.claude/agents/`）的功能；自定义子 Agent 是用 Agent 预设（YAML）选。【配置/代码】grep `.claude/agents`、`.dsh/agents` 无结果。
- **SDK 模式能用**：子 Agent 在同一进程里跑，有 `subagent.started` / `subagent.finished` 通知（后者只报进程内的），每个子会话的事件也在 `session.event` 里；`initialize` 的路由和 `maxTokens` 子 Agent 也继承。【文档】`packages/sdk/protocol/README.md`、`packages/sdk/server/README.md`。

### 5.8 会话日志上传和遥测（开关）

| 通道 | 默认 | 关法 | 出处 |
|---|---|---|---|
| `dsh_session_log`：每次 `deepseek-official` 请求体里附带会话日志的未确认部分（最多 8 MiB），**也发给自定义网关** | 开 | patch：`- id: session-log-deepseek` / `config: { enabled: false }`；网页"设置 → 通用 → 使用官方模型 API 时上传会话日志"；插件可 `ctx.sessionLogDeepSeek.registerExclusion()` 按请求排除。没有环境变量 | `packages/session/session-log-deepseek/README.md`；`docs/deepseek-llm-api-wire-extensions.md` 第 7 行 |
| `dsh_plugin_packages`：已启用的 npm 包名和版本 | 开 | `- id: plugin-package-inventory-deepseek` / `config: { enabled: false }` | `packages/llm/plugin-package-inventory-deepseek/README.md` 第 29 行；wire-extensions 文档第 160 行 |
| 请求头 `user-agent`、`x-deepseek-harness-user-id`（`$DSH_HOME/.anonymous-user-id` 里的匿名 UUID）、`x-deepseek-harness-session-id`、`x-deepseek-harness-compact` | 每次都发 | 没有开关，只能在网关去掉 | wire-extensions 文档「Request headers」 |
| OTel 会话导出到 `https://dsh-otel-collector.deepseeksvc.com/v1/logs` | `FEEDBACK_ONLY`：只在用户给出反馈（点赞点踩、文字反馈、编辑、撤回）后，把**整个会话日志前缀**传上去 | `DSH_TELEMETRY_MODE=DISABLED`，或任意非空的 `DSH_TELEMETRY_DISABLED`；`DSH_TELEMETRY_OTLP_URL` 改地址；不走 `HTTPS_PROXY`（用 Node 自己的 HTTP 客户端直连） | base patch `session-telemetry-otel` 行注释；`apps/cli/reference/README.md` 第 139 行；`docs/user/guide/network-proxy.md`「What stays direct」 |
| 桌面版产品分析 | 只有 Desktop | 不适用 | `packages/client/*/README.md` 开头的说明 |
| 官方 `GET /models` | 只有 `baseURL` 是官方地址且 `models` 没改时，每 10 分钟 | 用自定义 `baseURL` 就不发 | `packages/llm/llm-deepseek-api-key/README.md` |

- **SDK 模式**：上面这些在 SDK 里全部默认生效（都在 base 里），关法相同。SDK 里没有网页反馈按钮，`/feedback` 也不是 SDK 命令，所以 OTel 实际上很难被触发，但"SDK batching may finish an authorized upload without further interaction"。【文档】`apps/cli/reference/README.md`。建议和旧调研一样：SDK patch 里关掉前两行，设 `DSH_TELEMETRY_MODE=DISABLED`，网关再删掉所有 `dsh_*` 字段和 `x-deepseek-harness-*` 头。

---

## 6. 其他对云端多会话服务有影响的功能

- **会话恢复**：`session/resume {sessionId}`，同一个持久化存储（`$DSH_HOME/sessions`）；"preserves the stored origin and effective directory"；修复中断的最后一回合；不重放旧事件；缺失、不兼容、被占用（另一个进程在写）都会拒绝。后台任务、Shell、子进程不恢复。【文档】`packages/sdk/server/README.md`、`packages/sdk/client/README.md`。
- **会话文件**：`$DSH_HOME/sessions/--<规范化的 cwd>--/<会话 id>/session.vN.jsonl.zstd`，追加写，每会话一个写者（`flock` 锁 `session.lock`；POSIX 需要预编译的 `node-addon-system`，缺了就拿不到写权限）；**dsh 不删会话文件**。【文档】`packages/session/session-persistence-jsonl/README.md` 第 55–73、165–171 行。
- **多进程共用一个 `$DSH_HOME` 要小心**：`storage-json`（`$DSH_HOME/storages`，定时任务、投影缓存都在这里）"No cross-process write locking — two processes writing the same unit can interleave replacements"。【文档】`packages/storage/storage-json/README.md` 第 143 行。【推断】定时任务是宿主级的，两个进程共用一个 home 时可能都去触发同一个提醒。SeekCloud 应保持"一个会话容器一个 `$DSH_HOME`"。
- **一个进程多个会话**：可以，但 SDK 的 `initialize` 路由是整个进程共用的（见 1.2）。
- **工作目录**：默认是启动 `dsh` 的目录；SDK 有 `session/working-directory/get` 和 `/set`（对未知会话会直接建会话但不开回合）；模型有 `working_directory` 工具改当前会话目录。【文档】`apps/cli/README.md`；`packages/sdk/server/README.md`；`docs/tool-catalog.md`。
- **启动目录的 `.env` 会被当成启动环境加载**（凭据回退也读它）；但仓库自己的 `.env` 里如果写了 `HTTPS_PROXY` 之类代理变量，**dsh 直接拒绝启动**："DSH refuses to start rather than let a repository decide where your traffic goes"。【文档】`apps/cli/reference/README.md` 第 137 行；`docs/user/guide/network-proxy.md`。【推断】SeekCloud 在用户仓库目录里启动 dsh 时，要么换一个启动目录、再用 `working-directory/set` 指过去，要么接受"仓库 `.env` 带代理变量就起不来"并给出清楚的报错。
- **代理**：dsh 的模型请求、联网搜索、抓取、HTTP 的 MCP 都走 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，`NO_PROXY` 只认主机名和域名后缀（**不认 CIDR**），回环地址总是直连；不支持 SOCKS；Agent 跑的命令也继承这些变量（代理 URL 里的密码模型能读到）。PTC 和 workflow 的子进程不给代理。【文档】`docs/user/guide/network-proxy.md`。【推断】SeekCloud 沙箱的 `HTTPS_PROXY` 指向宿主机 Git 代理，dsh 发往我们模型网关的请求也会走它：要么让 Git 代理放行网关，要么把网关主机名放进 `NO_PROXY`。另外沙箱里的 `HTTPS_PROXY` 带着会话临时令牌，模型能读到——这和 ADR 0003 的设计一致（令牌只在本会话有效），但要记住。
- **Hooks**：实验 `@deepseek-ai/dsh-hooks-claude-code`（npm 上有，`next` = 0.2.2-rc.1，不是 `dsh` 的依赖，要另装），读 Claude Code 的 `hooks.json` 或 settings 文件的 `hooks` 键（`configPath`），支持 7 个事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart`、`SubagentStop`；Claude Code 现有 30 个事件里 23 个不支持；只跑 shell 命令型 handler；**整个进程一份配置，启动时读一次，相对路径按启动目录算**。还有 `hooks-codex`。原生插件可以挂 `tools/pre-execute`、`tools/post-execute`、`agent/pre-step`、`agent/turn-stopping`。【文档】`packages/experimental/hooks-claude-code/README.md`；npm registry（2026-11-08 查）。
- **取消**：SDK 仍然没有取消回合的方法，只能杀进程再 `session/resume`（旧调研的"桥接插件"方案仍然需要）。ACP 有 `session/cancel`。【文档】`packages/sdk/protocol/README.md`。
- **`ask_user_question` 的超时模式**：默认一直阻塞；设 `mode: timed` 后前台超时、返回"待回答"结果，问题仍可回答，`timeout: -1` 表示一直等。【文档】`docs/tool-catalog.md` 第 23 行。【推断】云端容器会休眠，"问题等待是进程内的"，用 timed 模式更稳。
- **会话标题**：SDK 里关掉了 `session-title-llm`（不额外调模型起标题）。【配置/代码】`packages/bundle/sdk-app/cordis.patch.yml`。
- **网页版的远程部署**：`dsh web` 默认只听回环地址，公开要反向代理 + `--public-url` + `--trusted-host`，靠启动令牌换 Cookie 认证；DeepSeek 账号的浏览器登录不支持非本机的反向代理。【文档】`docs/user/guide/public-deployments.md`；`packages/credentials/deepseek-account-platform/README.md`。
