# SeekCloud 的通用镜像（#17）：每个沙箱都从它起。用 Sysbox 运行（ADR 0005），沙箱里能跑 Docker。
#
# 构建（在 apps/host/sandbox 目录里，构建上下文是整个 sandbox 目录）：
#
#   docker build -f image/Dockerfile -t seekcloud-sandbox:$(cat image/VERSION) .
#
# 各工具链装的是构建当时的最新稳定版（Node 两个大版本按 NODE_MAJOR、DSH_NODE_MAJOR 选），
# 装了哪个版本记在镜像的 /etc/seekcloud/versions 里。下载的东西都按官方给的 SHA-256 核对。
FROM ubuntu:24.04

ARG NODE_MAJOR=22
ARG DSH_NODE_MAJOR=24
ARG SEEKCLOUD_IMAGE_VERSION=dev

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# 系统包：编译工具、常用命令行工具、Python、Java，以及后面几步要用的 curl、gnupg
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg tini sudo locales tzdata \
      build-essential pkg-config cmake make autoconf automake libtool \
      git git-lfs openssh-client \
      jq ripgrep fd-find tree file less nano vim-tiny unzip zip xz-utils zstd bzip2 \
      procps psmisc lsof iproute2 iputils-ping dnsutils netcat-openbsd rsync sqlite3 \
      python3 python3-pip python3-venv python3-dev pipx \
      openjdk-21-jdk-headless maven \
      libssl-dev zlib1g-dev libffi-dev \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && git lfs install --system \
 && rm -rf /var/lib/apt/lists/*

# Docker 引擎（沙箱里的 Docker）和 GitHub CLI，都用官方的 apt 源
RUN install -m 0755 -d /etc/apt/keyrings \
 && arch="$(dpkg --print-architecture)" \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin gh \
 && rm -rf /var/lib/apt/lists/*

COPY image/install-node.sh /usr/local/lib/seekcloud/install-node.sh

# 系统的 Node（管理员和 Agent 用的，装在 /usr/local，可以随便换版本）；pnpm、yarn 由 corepack 提供
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN bash /usr/local/lib/seekcloud/install-node.sh "${NODE_MAJOR}" /usr/local \
 && corepack enable \
 && corepack prepare pnpm@latest --activate

# Go：官方的二进制包
ENV GOPATH=/root/go
ENV PATH=/usr/local/go/bin:${GOPATH}/bin:${PATH}
RUN arch="$(dpkg --print-architecture)" \
 && version="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -n 1)" \
 && file="${version}.linux-${arch}.tar.gz" \
 && sha="$(curl -fsSL 'https://go.dev/dl/?mode=json' | jq -r --arg f "$file" '.[].files[] | select(.filename == $f) | .sha256')" \
 && test -n "$sha" \
 && curl -fsSLo "/tmp/${file}" "https://go.dev/dl/${file}" \
 && echo "${sha}  /tmp/${file}" | sha256sum -c - \
 && tar -C /usr/local -xzf "/tmp/${file}" \
 && rm "/tmp/${file}"

# Rust：rustup 装稳定版，带 rustfmt 和 clippy
ENV RUSTUP_HOME=/opt/rust/rustup \
    CARGO_HOME=/opt/rust/cargo
ENV PATH=/opt/rust/cargo/bin:${PATH}
RUN case "$(dpkg --print-architecture)" in \
      amd64) triple=x86_64-unknown-linux-gnu ;; \
      arm64) triple=aarch64-unknown-linux-gnu ;; \
      *) echo "不支持的架构" >&2; exit 1 ;; \
    esac \
 && base="https://static.rust-lang.org/rustup/dist/${triple}" \
 && curl -fsSLo /tmp/rustup-init "${base}/rustup-init" \
 && echo "$(curl -fsSL "${base}/rustup-init.sha256" | cut -d ' ' -f 1)  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain stable \
      --component rustfmt --component clippy \
 && rm /tmp/rustup-init

# Python 的 uv（pipx 装，命令放在 /usr/local/bin）
ENV PIPX_HOME=/opt/pipx \
    PIPX_BIN_DIR=/usr/local/bin
RUN pipx install uv

# Chromium 和 Playwright：浏览器装在 /opt/pw-browsers，任何目录里 require('playwright') 都找得到
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    NODE_PATH=/usr/local/lib/node_modules
RUN npm install --global "playwright@$(npm view playwright version)" \
 && playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

# dsh 自己的一份 Node（≥ 24.9，ADR 0004），和系统的 Node 分开：管理员改 PATH、换系统 Node 的版本都不影响 dsh。
# /usr/local/bin/dsh 用这份 Node 的绝对路径启动 dsh，不经过 PATH 找 node。
# 版本号在 dsh/VERSION（CI 里测真的 dsh 也按它装）。这几层放在后面：换 dsh 的版本不用重装上面的工具链。
COPY dsh/VERSION /usr/local/share/seekcloud/dsh/VERSION
RUN bash /usr/local/lib/seekcloud/install-node.sh "${DSH_NODE_MAJOR}" /opt/seekcloud/node \
 && /opt/seekcloud/node/bin/npm install --global --prefix /opt/seekcloud/dsh \
      "@deepseek-ai/dsh@$(cat /usr/local/share/seekcloud/dsh/VERSION)" \
 && printf '#!/bin/sh\nexec /opt/seekcloud/node/bin/node /opt/seekcloud/dsh/bin/dsh "$@"\n' > /usr/local/bin/dsh \
 && chmod 755 /usr/local/bin/dsh \
 && /opt/seekcloud/node/bin/npm cache clean --force

# SeekCloud 自己的文件：签名助手、git 钩子、dsh 的基线配置和 Claude Code 技能的插件（apps/host/sandbox/README.md）
COPY seekcloud-sign /usr/local/bin/seekcloud-sign
COPY gh /usr/local/bin/gh
COPY git-hooks/ /usr/local/share/seekcloud/git-hooks/
COPY dsh/ /usr/local/share/seekcloud/dsh/
COPY image/seekcloud-init /usr/local/bin/seekcloud-init
COPY runner/seekcloud-runner.mjs /usr/local/lib/seekcloud/seekcloud-runner.mjs
COPY image/check.sh /usr/local/lib/seekcloud/check.sh

# dsh 的遥测关掉（基线配置里也关了，这是第二道）；提交尾注默认开着，宿主机准备沙箱时按设置重写
ENV DSH_TELEMETRY_MODE=DISABLED
RUN mkdir -p /etc/seekcloud /workspace \
 && echo on > /etc/seekcloud/commit-trailer \
 && { \
      echo "image=${SEEKCLOUD_IMAGE_VERSION}"; \
      echo "node=$(node --version)"; \
      echo "dsh_node=$(/opt/seekcloud/node/bin/node --version)"; \
      echo "dsh=$(cat /usr/local/share/seekcloud/dsh/VERSION)"; \
      echo "python=$(python3 --version | cut -d ' ' -f 2)"; \
      echo "go=$(go env GOVERSION)"; \
      echo "rust=$(rustc --version | cut -d ' ' -f 2)"; \
      echo "java=$(java -version 2>&1 | head -n 1 | cut -d '"' -f 2)"; \
      echo "docker=$(docker --version | cut -d ' ' -f 3 | tr -d ,)"; \
      echo "gh=$(gh --version | head -n 1 | cut -d ' ' -f 3)"; \
      echo "playwright=$(playwright --version | cut -d ' ' -f 2)"; \
    } > /etc/seekcloud/versions \
 && cat /etc/seekcloud/versions

LABEL cn.seekcloud.image.version="${SEEKCLOUD_IMAGE_VERSION}"
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/seekcloud-init"]
