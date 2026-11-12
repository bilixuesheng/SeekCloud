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

这是 AI 标识的一种，默认加上：Agent 在会话里被要求去掉也照加。管理员可以在"设置 → GitHub"里关掉"提交尾注"，是否关闭由部署者自行负责。GitHub 工具建的提交已经跟着这个开关；沙箱里的 git 钩子现在还是一律加，接上开关的工作见 issue #59。

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
