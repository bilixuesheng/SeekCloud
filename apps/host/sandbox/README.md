# 沙箱里的 Git 配置

宿主机建沙箱时，按下面配好 git 和 `gh`，沙箱里就不需要任何 GitHub 凭据。规则见 ADR 0003。

## 环境变量

| 变量 | 值 | 用途 |
|---|---|---|
| `HTTPS_PROXY`、`https_proxy` | `http://session:<会话临时令牌>@<宿主机地址>:<代理端口>` | 所有 HTTPS 出站都经过宿主机；GitHub 的请求由 Git 代理处理 |
| `GH_TOKEN`、`GITHUB_TOKEN` | `proxy-injected` | 占位符，代理换成用户的令牌。用户在环境里自己设了的，原样传入 |
| `SEEKCLOUD_SESSION_TOKEN` | 会话临时令牌 | 签名助手用它向宿主机表明身份 |
| `SEEKCLOUD_SIGN_URL` | `http://<宿主机地址>:<代理端口>/sign` | 签名服务 |
| `NODE_EXTRA_CA_CERTS`、`GIT_SSL_CAINFO` 等 | 代理 CA 证书的路径 | 让各种工具信任代理解密 GitHub 流量用的证书 |
| `GIT_CONFIG_COUNT`、`GIT_CONFIG_KEY_0`、`GIT_CONFIG_VALUE_0` | `1`、`core.hooksPath`、`/usr/local/share/seekcloud/git-hooks` | 提交说明加 AI 生成的尾注，见下面"提交说明里的 AI 标识" |

代理的 CA 证书还要装进系统的信任列表（`/usr/local/share/ca-certificates/` 再 `update-ca-certificates`）。

## git 配置（`git config --system`）

```ini
[user]
	name = SeekCloud
	email = <SeekCloud 账号的邮箱>
	signingkey = key::<SeekCloud 签名公钥，一行 ssh-ed25519 …>
[gpg]
	format = ssh
[gpg "ssh"]
	program = /usr/local/bin/seekcloud-sign
[commit]
	gpgsign = true
[url "https://github.com/"]
	insteadOf = git@github.com:
	insteadOf = ssh://git@github.com/
[push]
	negotiate = true
[http]
	# 第一次请求就带上代理凭据，省一个来回
	proxyAuthMethod = basic
```

`seekcloud-sign` 是本目录下的脚本，装进通用镜像。克隆仓库时默认 `--depth 50`。

## 提交说明里的 AI 标识

Agent 的每个提交，说明末尾都有一行尾注：

```
Generated-by: SeekCloud (AI)
```

这是 AI 标识的一种，默认加上：Agent 在会话里被要求去掉也照加。管理员可以在"设置 → GitHub"里关掉"提交尾注"，是否关闭由部署者自行负责。GitHub 工具建的提交和沙箱里的 git 钩子都跟着这个开关。

- 钩子从沙箱里的 `/etc/seekcloud/commit-trailer` 读开关（测试里用环境变量 `SEEKCLOUD_COMMIT_TRAILER_FILE` 换成别的路径）：内容是 `off` 时不加，`on` 时加。宿主机在准备沙箱时、收到 `set_ai_labels` 时、每个回合开始时都按 `prepare_sandbox`、`set_ai_labels` 里的 `aiLabels.commitTrailer` 写一遍。
- 钩子每次提交都重新读，运行中改了开关，下一个提交就照新的来。文件不在、不是普通文件、内容不是 `off` 时都按开着处理：Agent 在沙箱里是 root，改得了这个文件，所以它不是安全边界，只是默认行为。
- 关着时不加，也不去掉说明里已有的尾注（压缩提交时各自的尾注原样留着）。

- 本目录的 `git-hooks/` 整个装进通用镜像的 `/usr/local/share/seekcloud/git-hooks`，保留里面的符号链接（每个钩子都链接到 `_dispatch`）。
- `core.hooksPath` 用上面的环境变量设，不写进 `git config --system`：环境变量里的配置盖过仓库自己的，用 husky 这类工具设了 `core.hooksPath` 的仓库也跑我们的钩子。`_dispatch` 先跑仓库原本会跑的同名钩子（`.git/hooks` 或仓库设的 `core.hooksPath`），所以仓库的检查照常生效。
- `prepare-commit-msg` 和 `commit-msg` 都加一次：`--no-verify` 会跳过 `commit-msg`，仓库的 `commit-msg` 又可能改写说明。合并、拣选、撤销、`rebase -i` 压缩出来的提交也带上；压缩时说明中间各自的尾注会去掉，只在末尾留一行。
- 拣选别人的提交时也加：提交者是 SeekCloud 账号，宁可多标。
- `git commit-tree` 这类底层命令不经过钩子，不会加。

## GitHub 工具

宿主机在 Git 代理的同一个端口上提供 GitHub 工具服务（MCP）：`POST http://<宿主机地址>:<代理端口>/mcp`，会话临时令牌放在 `Authorization: Bearer <令牌>` 里。dsh 的 MCP 配置里加一个叫 `github` 的服务，Agent 看到的工具就是 `mcp__github__*`，名字和参数照 GitHub 官方 MCP 服务（Claude Code 网页版用的也是它）。

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "http://<宿主机地址>:<代理端口>/mcp",
      "headers": { "Authorization": "Bearer <会话临时令牌>" }
    }
  }
}
```

- 这个地址是沙箱直连宿主机，不经过 `HTTPS_PROXY`。
- 工具以用户本人的 GitHub 账号操作，只能碰本会话挂载的仓库：每个 REST 请求都先过 Git 代理的同一套规则（`src/git-proxy/rules.ts`），所以工具能做的不会比沙箱里的 `gh` 多。
- 只有 GraphQL 能做的几件事，由服务用写死的查询代为调用，调用前先确认仓库挂载在本会话上：评审线程的读取、解决和重开，开关自动合并，往未提交的 review 里加行内评论。搜索也一样，服务会把查询限定在本会话的仓库里。
- 写到 GitHub 上的正文（issue、PR、评论、review）末尾统一加一次"由 SeekCloud 生成（AI）"的署名，重复的会去掉。管理员在"设置 → GitHub"里关掉"署名"以后不加，Agent 自己写了的也不删。
- 工具建的提交（`create_or_update_file`、`delete_file`、`push_files`）说明末尾带 `Generated-by: SeekCloud (AI)`，和沙箱里的 git 钩子一样；关掉"提交尾注"以后不加。这些提交以用户本人的账号提交（照官方），不是 SeekCloud 账号。分支和沙箱里的 git 一样任何分支都能写，删分支、建标签不放行。
- 组织级的工具（团队、issue 类型和字段）只查挂载了仓库的所有者。
- 代码在 `apps/host/src/github-tools/`，测试接一个假的 GitHub API（`github-tools.test.ts`），在普通 CI 上跑。

## 模型网关

沙箱里的 dsh 调模型、传图片、联网搜索和抓取网页，都发到宿主机本地、和 Git 代理同一个端口的 `/v1/…`，宿主机核对会话临时令牌以后转给主站的模型网关（`src/model-gateway/forward.ts`，ADR 0003）。dsh 的 DeepSeek 接口地址设成 `http://<宿主机地址>:<代理端口>`（不带路径），API key 设成会话临时令牌：

| 路径 | 用途 | dsh 怎么带令牌 |
|---|---|---|
| `POST /v1/messages` | 调模型（流式逐个事件转发） | `x-api-key` |
| `POST /v1/files`、`GET /v1/files`、`GET`/`DELETE /v1/files/{id}` | 上传给模型看的图片；每个会话只看得到自己传的 | `x-api-key` |
| `POST /v1/tools/search` | 联网搜索（DeepSeek 搜索接口的格式） | `Authorization: Bearer` |

- 这个地址是沙箱直连宿主机，不经过 `HTTPS_PROXY`，任何网络策略下都通。
- 宿主机转给主站时去掉会话令牌和 dsh 夹带的请求头，只留 `content-type`、`anthropic-version`、`anthropic-beta` 这几个，换上宿主机凭据和会话 ID；路径里带 `..` 或编码过的斜杠的不转。主站剥字段、换上提供方的 key（`apps/site/src/server/gateway/`）。
- 宿主机还没连上主站时回 503，dsh 会按它自己的规则重试。
- dsh 的模型目录（它会去取接口地址那个域名下的 `/models`）宿主机不提供，用 dsh 自带的；接 dsh 的时候（#25）核对一下取不到时的表现。

## dsh 的基线配置

`dsh/baseline.patch.yml` 装进通用镜像的 `/usr/local/share/seekcloud/dsh/`，宿主机启动 dsh 时作为最后一个 `--patch` 叠上去，同时设 `DSH_TELEMETRY_MODE=DISABLED`：

```
dsh --profile sdk [--patch <Agent 模式的叠加配置>] --patch /usr/local/share/seekcloud/dsh/baseline.patch.yml
```

命令行的 `--patch` 排在 profile 和 `$DSH_HOME/cordis.patch.yml` 后面，后面的盖过前面的，所以沙箱里的配置文件打不开基线关掉的东西。基线做了这几件事（ADR 0004、issue #17）：

- 关掉会话日志上传（`session-log-deepseek`）、插件清单上报（`plugin-package-inventory-deepseek`）和反馈遥测（`session-telemetry-otel`）。匿名 ID 请求头 dsh 没有开关，由模型网关剥掉。
- 关掉 dsh 自带的定时提醒（`tool-schedule`），定时任务和会话提醒由平台做。插件管理工具保持打开。
- 前台命令的超时：默认 2 分钟，最长 10 分钟。
- 工具输出太长时写出来的文件放在 `$DSH_HOME/spill` 下面，沙箱休眠再启动以后还在。

`src/dsh-baseline.test.ts` 检查这些。普通 CI 里没有 dsh，只查文件本身；设了 `SEEKCLOUD_DSH_BIN`（指向 dsh 的可执行文件，要 Node 24.9 以上）时，还用 `dsh --profile sdk --dump-config` 合成真的配置，并在 `$DSH_HOME/cordis.patch.yml` 里试着把关掉的重新打开，确认打不开。构建通用镜像时设上它跑一遍。
