<p align="center"><img src="apps/site/public/brand/whale.webp" width="120" alt="SeekCloud 标志"></p>

# SeekCloud

中文 | [English](README.en.md)

SeekCloud 是一个可以自己部署的云端编程 Agent，支持 DeepSeek 模型。在手机、电脑等任意设备上发起会话后，Agent 在云端的沙箱中读写代码仓库、运行命令，并把改动推送到 GitHub。每套部署只有一个管理员账户，供部署者自己使用。

本仓库是 SeekCloud 付费版的开源、自部署主干版本。SeekCloud 是独立项目，非 DeepSeek 官方产品。

## 现状

**早期开发中，目前不能用于实际部署。**

Agent 已经能在沙箱中完整地执行一个回合：克隆仓库、修改代码、提交并推送到会话分支。这一流程已在测试机上验证，验证时使用的是模拟的 GitHub 和模型，尚未用真实的 GitHub 仓库和 DeepSeek 验收。主站可以用安装脚本部署（见下文"部署"），沙箱宿主机目前需要手动安装。界面有中文和英文两种。

已完成的部分：

- 主站：管理员密码登录，关联 GitHub 并选择仓库和分支，发起和查看会话，导出数据。界面是可以添加到手机主屏幕的 PWA。
- 模型网关：沙箱调用模型的唯一通道，上传给模型看的图片、联网搜索和网页抓取也经过它；抓取不连内网和本机地址。替换成管理员填的 DeepSeek API key（加密存放），剥掉 Agent 夹带的数据，流式转发，记录每次调用的用量；每个会话只看得到自己上传的文件；上游出错时，沙箱只看到说明、状态码和参考号，原始报错只给管理员看。
- 沙箱宿主机：连接主站（宿主机密钥认证，断线自动重连并补发），Git 代理（只允许访问本会话的仓库，并为提交签名）和 GitHub 工具服务（MCP）。

## 计划中的功能

- 网页图形化部署：Linux 上运行一条命令，Windows 上运行一条 PowerShell 命令，其余步骤在网页向导中完成
- 多渠道通知：SMTP 邮件、PWA 推送、飞书、钉钉和企业微信机器人、通用 Webhook
- 支持 Windows：主站和沙箱宿主机都可以通过 WSL2 安装在 Windows 上
- 安卓 App：首次打开时输入服务器地址
- 检查更新和一键更新：在设置中检查新版本，一键更新到本仓库发布的版本，正在运行的会话不中断
- 更多 Agent 功能：开放沙箱中的 Agent（dsh）目前未开放的插件市场、几种模式（如创造模式）、轨迹视图等
- GitHub 上的 AI 标识：issue、PR 和评论末尾的署名以及提交尾注默认注明由 AI 生成，可以在设置中关闭

## 部署

主站（网页和接口）、PostgreSQL 和反向代理 Caddy 用 Docker Compose 运行，安装脚本一条命令装好。支持 Ubuntu 22.04、24.04 和 Debian 12（amd64 或 arm64）。

在服务器上用 root 运行：

```sh
curl -fsSLO https://github.com/bilixuesheng/SeekCloud/releases/latest/download/install.sh
curl -fsSLO https://github.com/bilixuesheng/SeekCloud/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS && sudo bash install.sh
```

本仓库发布第一个版本之后才有这两个文件。在那之前，可以克隆本仓库，自己构建主站的镜像再安装：

```sh
docker build -f apps/site/Dockerfile -t seekcloud-site:dev .
sudo bash scripts/install.sh --image seekcloud-site:dev
```

安装脚本会：

1. 检查系统、内存和磁盘；内存不到 1 GB 时提示可能不够。机器是 LXC、OpenVZ 这类容器时，主站照样能装，但这台机器不能当沙箱宿主机。
2. 没有 Docker 时，从 Docker 的软件源安装 Docker Engine（核对 Docker 官方签名密钥的指纹）。
3. 生成 `SEEKCLOUD_SECRET_KEY` 和数据库密码，写进只有 root 能读的文件，不在终端显示。
4. 测试几个公开的镜像站和默认的镜像仓库，从拉得最快的拉取镜像。
5. 启动，等主站的健康检查通过，打印网页地址。

装好以后，**请立即打开网页设置管理员密码**：设置之前，任何打开这个地址的人都能成为管理员。然后在"设置 → 模型"中填写 DeepSeek API key。

安装脚本可以重复运行：已有的密钥和数据不变，只补缺的部分。

| 参数 | 说明 |
|---|---|
| `--data-dir 目录` | 数据、密钥和 Compose 文件的位置，默认 `/var/lib/seekcloud` |
| `--no-caddy` | 不安装 Caddy，供已经有反向代理的服务器使用。主站只监听 `127.0.0.1:端口`，由你的反向代理转发过来 |
| `--port 端口` | 使用 `--no-caddy` 时主站监听的端口，默认 3000 |
| `--proxy-hops 层数` | 主站前面有几层反向代理，默认 1 |
| `--registry 地址` | 所有镜像都从这个镜像仓库或镜像站拉取，不再测试公开的镜像站 |
| `--image 镜像` | 主站使用的镜像，默认是与安装脚本同一版本的发布镜像 |
| `--lang zh\|en` | 提示的语言 |

数据目录里的内容：

| 位置 | 内容 |
|---|---|
| `compose.yml`、`Caddyfile` | 安装脚本生成，重新运行时会覆盖 |
| `site.env`、`postgres.env` | 密钥和数据库密码，只有 root 能读。**`SEEKCLOUD_SECRET_KEY` 不在备份中，请另外保存 `site.env`**：密钥丢失后，库中加密的令牌和 key 都无法使用 |
| `postgres/` | 数据库 |
| `site/` | 主站的数据目录（导出的压缩包、Agent 的会话文件） |
| `caddy/` | Caddy 的证书和配置 |

数据库只在 Compose 的内部网络中，不对外开放；主站以非 root 用户运行。刚装好时用 `http://服务器地址/` 访问；域名和 HTTPS 将在部署向导中配置。

常用操作（`<数据目录>` 默认是 `/var/lib/seekcloud`）：

```sh
# 查看日志
docker compose -f <数据目录>/compose.yml logs -f site
# 忘记管理员密码：打印一个随机的新密码，所有设备退出登录
docker compose -f <数据目录>/compose.yml exec site node dist/server/reset-password.js
# 添加沙箱宿主机：打印宿主机密钥（见"连接沙箱宿主机"）
docker compose -f <数据目录>/compose.yml exec site node dist/server/host.js create <名字>
```

使用 `--no-caddy` 时，你的反向代理需要：

- 把客户端地址追加到 `X-Forwarded-For`，并设置 `X-Forwarded-Proto`；
- 转发 WebSocket（沙箱宿主机通过 `/api/hosts/connect` 连接主站）；
- 不缓冲 `text/event-stream` 的响应（会话页的实时更新）。

前面不止一层反向代理时（比如 CDN 加上你自己的反向代理），用 `--proxy-hops` 设置层数。层数设多了，客户端可以伪造地址绕过按来源的频率限制；设少了，所有人都会被当成同一个地址。

拉不动镜像时，可以在 `/etc/docker/daemon.json` 中给 Docker 配置镜像加速（`registry-mirrors`），运行 `systemctl restart docker` 后再运行安装脚本；也可以用 `--registry` 指定一个镜像站。

## 开发

### 环境要求

- Node.js 22 或更高版本
- pnpm 10
- PostgreSQL（CI 使用 16）
- 沙箱宿主机的测试还需要 `git`、`openssl` 和 `ssh-keygen`

### 仓库结构

| 路径 | 内容 |
|---|---|
| `apps/site` | 主站：Hono 接口和 React PWA |
| `apps/host` | 沙箱宿主机的守护进程：Git 代理、提交签名、GitHub 工具服务 |
| `apps/host/sandbox` | 沙箱中安装的 git 配置、钩子和签名助手 |
| `apps/android` | 安卓 App（Kotlin、Jetpack Compose），独立的 Gradle 工程，不属于 pnpm 工作区。在其中运行 `./gradlew testDebugUnitTest lintDebug assembleDebug`，需要 JDK 17 以上和安卓 SDK |
| `packages/protocol` | 主站和沙箱宿主机共用的协议定义 |
| `docs/adr` | 架构决定记录 |
| `docs/brand` | 标志、配色和界面文案规范 |
| `GLOSSARY.md` | 领域术语 |

### 常用命令

在仓库根目录运行：

```sh
pnpm install     # 安装依赖
pnpm typecheck   # 类型检查
pnpm lint        # Biome 检查；pnpm format 自动修正
pnpm test        # 运行测试
pnpm build       # 构建
```

CI 运行后四项。

### 测试数据库

主站的测试需要 PostgreSQL，默认连接 `postgres://postgres:postgres@localhost:5432/postgres`，可以用环境变量 `TEST_DATABASE_URL` 指定其他地址。测试会在其中创建和删除临时数据库，因此该用户需要建库权限。

### 在本地运行主站

在 `apps/site` 目录下，分别在两个终端中运行：

```sh
# 接口，监听 3000 端口；启动时自动执行数据库迁移
DATABASE_URL=postgres://<用户>:<密码>@localhost:5432/<数据库> \
SEEKCLOUD_SECRET_KEY=<密钥> \
pnpm dev:server

# 前端，监听 5173 端口，并把 /api 转发到 3000 端口
pnpm dev
```

然后打开 http://localhost:5173 ，首次访问时设置管理员密码，再在"设置 → 模型"中填写 DeepSeek API key（没有填写时无法发起会话）。

主站的环境变量：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接地址，必填 |
| `SEEKCLOUD_SECRET_KEY` | 加密 GitHub 令牌用的 32 字节密钥（base64），必填。用 `openssl rand -base64 32` 生成一次并妥善保存；更换后，已保存的令牌无法解密 |
| `PORT` | 监听端口，默认 3000 |
| `SEEKCLOUD_DATA_DIR` | 数据目录，存放导出的压缩包，默认 `./data` |
| `SEEKCLOUD_VERSION` | 版本号，由健康检查接口 `/api/health` 返回，默认 `dev` |
| `PUBLIC_URL` | 主站对外的地址，GitHub 回调、通行密钥使用。以 `https://` 开头时，登录 Cookie 只通过 HTTPS 发送；未配置时，按每个请求是否经 HTTPS 到达决定 |
| `SEEKCLOUD_PROXY_HOPS` | 主站前面有几层反向代理（0 到 5），默认 1。0 表示主站直接对外，按连接的来源地址识别客户端；N 表示取 `X-Forwarded-For` 的倒数第 N 个。只是初始值，之后可以在设置里修改。填错会让按来源的频率限制失效或误伤所有人 |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_APP_SLUG`、`GITHUB_WEBHOOK_SECRET` | GitHub App 的配置。未配置时，GitHub 相关功能不可用 |

`pnpm build` 构建前端（`apps/site/dist/client`）和服务端（`apps/site/dist/server`），之后在 `apps/site` 中用 `pnpm start` 运行构建好的主站。

忘记管理员密码时，在 `apps/site` 中运行 `DATABASE_URL=... pnpm admin:reset-password`。它会打印一个随机的新密码，并让所有设备退出登录。

### 连接沙箱宿主机

1. 在 `apps/site` 中运行 `DATABASE_URL=... pnpm host:create <名字>`（名字用小写字母、数字和连字符），记下打印出来的宿主机密钥。密钥只显示这一次，主站只保存它的哈希。
2. 在宿主机上，于 `apps/host` 中运行：

   ```sh
   SEEKCLOUD_SITE_URL=<主站对外的地址> SEEKCLOUD_HOST_KEY=<宿主机密钥> pnpm start
   ```

   宿主机会主动连接主站，断线后自动重连。
3. 不再使用某台宿主机时，运行 `DATABASE_URL=... pnpm host:revoke <名字>` 吊销它的密钥，已有的连接会在几秒内断开。

宿主机断开连接超过一定时长（默认 2 分钟，可在"设置 → 会话"中修改），其上正在运行的会话会标记为失败。

## 许可证

本项目依据 [GNU Affero 通用公共许可证第 3 版](LICENSE)（AGPL-3.0）授权，并附有一项署名附加条款（依据 AGPL-3.0 第 7 条 (b) 项）：SeekCloud 及其修改版本，必须在界面的“开源声明”页保留“基于 SeekCloud（https://github.com/bilixuesheng/SeekCloud）”这一署名。条款原文见 [NOTICE](NOTICE)。

参与贡献之前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
