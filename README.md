<p align="center"><img src="apps/site/public/brand/whale.webp" width="120" alt="SeekCloud 标志"></p>

# SeekCloud

中文 | [English](README.en.md)

SeekCloud 是一个可以自己部署的云端编程 Agent，支持 DeepSeek 模型。在手机、电脑等任意设备上发起会话后，Agent 在云端的沙箱中读写代码仓库、运行命令，并把改动推送到 GitHub。每套部署只有一个管理员账户，供部署者自己使用。

SeekCloud 是独立的开源项目，非 DeepSeek 官方产品。

## 现状

**早期开发中，目前不能用于实际部署。**

Agent 执行尚未实现：主站未接入沙箱宿主机，新会话会一直处于排队状态。界面目前只有中文。

已完成的部分：

- 主站：管理员密码登录，关联 GitHub 并选择仓库和分支，发起和查看会话，导出数据。界面是可以添加到手机主屏幕的 PWA。
- 沙箱宿主机：Git 代理（只允许访问本会话的仓库，并为提交签名）和 GitHub 工具服务（MCP）。

## 计划中的功能

- 网页图形化部署：Linux 上运行一条命令，Windows 上运行一条 PowerShell 命令，其余步骤在网页向导中完成
- 多渠道通知：SMTP 邮件、PWA 推送、飞书、钉钉和企业微信机器人、通用 Webhook
- 支持 Windows：主站和沙箱宿主机都可以通过 WSL2 安装在 Windows 上
- 安卓 App：首次打开时输入服务器地址
- 检查更新和一键更新：在管理后台检查新版本，由服务器从本仓库拉取更新
- 更多 Agent 功能：开放沙箱中的 Agent（dsh）目前未开放的插件市场、几种模式（如创造模式）、轨迹视图等
- GitHub 上的 AI 标识：issue、PR 和评论末尾的署名以及提交尾注默认注明由 AI 生成，可以在设置中关闭

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

然后打开 http://localhost:5173 ，首次访问时设置管理员密码。

主站的环境变量：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接地址，必填 |
| `SEEKCLOUD_SECRET_KEY` | 加密 GitHub 令牌用的 32 字节密钥（base64），必填。用 `openssl rand -base64 32` 生成一次并妥善保存；更换后，已保存的令牌无法解密 |
| `PORT` | 监听端口，默认 3000 |
| `SEEKCLOUD_DATA_DIR` | 数据目录，存放导出的压缩包，默认 `./data` |
| `SEEKCLOUD_VERSION` | 版本号，由健康检查接口 `/api/health` 返回，默认 `dev` |
| `NODE_ENV` | 设为 `production` 时，登录 Cookie 只通过 HTTPS 发送 |
| `PUBLIC_URL` | 主站对外的地址，GitHub 回调使用 |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_APP_SLUG`、`GITHUB_WEBHOOK_SECRET` | GitHub App 的配置。未配置时，GitHub 相关功能不可用 |

忘记管理员密码时，在 `apps/site` 中运行 `DATABASE_URL=... pnpm admin:reset-password`。它会打印一个随机的新密码，并让所有设备退出登录。

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 许可证，另见 [NOTICE](NOTICE)。
