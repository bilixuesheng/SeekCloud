#!/usr/bin/env bash
#
# SeekCloud 主站的安装脚本（#94）。在一台新的 Linux 服务器上用 root 运行：
# 检查系统 → 装 Docker Engine → 生成密钥 → 选镜像站、拉镜像 → 用 Docker Compose 起主站、PostgreSQL 和 Caddy
# → 等健康检查通过 → 打印网页地址。其余配置在网页上的部署向导里完成。
#
# 可以重复运行：已有的密钥和数据不动，只补缺的；Compose 文件和 Caddyfile 每次重新生成。
# 只从固定的地址下载：Docker 的 apt 源（核对 GPG 指纹）和镜像仓库，不再下载别的脚本来执行。
#
# SeekCloud installer (#94). Run as root on a fresh Linux server. Safe to re-run: existing secrets and data
# are kept. Run with --help for options.

set -euo pipefail

# 发布时换成版本号（一键更新的规格里定怎么发，#108）
SEEKCLOUD_VERSION="latest"
SITE_IMAGE_DEFAULT="ghcr.io/bilixuesheng/seekcloud-site:${SEEKCLOUD_VERSION}"
POSTGRES_IMAGE="postgres:16-alpine"
CADDY_IMAGE="caddy:2-alpine"

# 公开的镜像站，随版本更新。镜像站来来去去：测不通的跳过，不当作失败（#94 的 2026-11-18 评论）。
DOCKERHUB_MIRRORS=(docker.m.daocloud.io docker.1ms.run)
GHCR_MIRRORS=(ghcr.m.daocloud.io ghcr.nju.edu.cn)
# Docker 的 apt 源：先官方，再几个公开的镜像。签名密钥不管从哪里下，都要核对官方的指纹。
DOCKER_APT_SOURCES=(
  https://download.docker.com
  https://mirrors.aliyun.com/docker-ce
  https://mirrors.tuna.tsinghua.edu.cn/docker-ce
)
DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

DATA_DIR="/var/lib/seekcloud"
WITH_CADDY=1
PORT=3000
PROXY_HOPS=""
REGISTRY=""
SITE_IMAGE=""
LANG_CHOICE=""

# ── 输出 ─────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
  BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# 每句话都给中文和英文两份，按 --lang 或系统语言选
pick() { if [[ "$LANG_CHOICE" == "en" ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
stage() { printf '\n%s%s▸ %s%s\n' "$BOLD" "$BLUE" "$(pick "$1" "$2")" "$RESET"; }
info() { printf '  %s\n' "$(pick "$1" "$2")"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$(pick "$1" "$2")"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$(pick "$1" "$2")" "$RESET"; }
note() { printf '  %s%s%s\n' "$DIM" "$(pick "$1" "$2")" "$RESET"; }
fail() {
  printf '\n  %s✗ %s%s\n' "$RED" "$(pick "$1" "$2")" "$RESET" >&2
  exit 1
}

usage() {
  if [[ "$LANG_CHOICE" == "en" ]]; then
    cat <<'EOF'
Usage: sudo bash install.sh [options]

Installs the SeekCloud main site (site, PostgreSQL, Caddy) with Docker Compose.

Options:
  --data-dir DIR      Where data, secrets and the Compose file live (default /var/lib/seekcloud)
  --no-caddy          Do not install Caddy, for servers that already have a reverse proxy.
                      The site then listens on 127.0.0.1:PORT only.
  --port PORT         Port for --no-caddy (default 3000)
  --proxy-hops N      Number of reverse proxies in front of the site (default 1)
  --registry HOST     Pull every image through this registry or mirror instead of testing public mirrors
  --image REF         Site image to run (default: the published image of this version)
  --lang zh|en        Language of the messages
  -h, --help          Show this help
EOF
  else
    cat <<'EOF'
用法：sudo bash install.sh [选项]

用 Docker Compose 安装 SeekCloud 主站（主站、PostgreSQL、Caddy）。

选项：
  --data-dir 目录     数据、密钥和 Compose 文件放在哪里（默认 /var/lib/seekcloud）
  --no-caddy          不装 Caddy，给已经有反向代理的服务器用。主站只监听 127.0.0.1:端口
  --port 端口         --no-caddy 时主站监听的端口（默认 3000）
  --proxy-hops 层数   主站前面有几层反向代理（默认 1）
  --registry 地址     所有镜像都从这个镜像仓库或镜像站拉，不再测试公开的镜像站
  --image 镜像        主站用的镜像（默认是这个版本发布的镜像）
  --lang zh|en        提示用哪种语言
  -h, --help          显示这段说明
EOF
  fi
}

# ── 参数 ─────────────────────────────────────────────────────────────────

ARGS=("$@")
for ((i = 0; i < ${#ARGS[@]}; i++)); do
  if [[ "${ARGS[$i]}" == "--lang" ]]; then LANG_CHOICE="${ARGS[$((i + 1))]:-}"; fi
done
if [[ -z "$LANG_CHOICE" ]]; then
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
    en*) LANG_CHOICE="en" ;;
    *) LANG_CHOICE="zh" ;;
  esac
fi
[[ "$LANG_CHOICE" == "zh" || "$LANG_CHOICE" == "en" ]] || LANG_CHOICE="zh"

need_value() {
  [[ $# -ge 2 && -n "$2" ]] || fail "参数 $1 后面要跟一个值" "Option $1 needs a value"
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) need_value "$@"; DATA_DIR="$2"; shift 2 ;;
    --no-caddy) WITH_CADDY=0; shift ;;
    --port) need_value "$@"; PORT="$2"; shift 2 ;;
    --proxy-hops) need_value "$@"; PROXY_HOPS="$2"; shift 2 ;;
    --registry) need_value "$@"; REGISTRY="${2%/}"; shift 2 ;;
    --image) need_value "$@"; SITE_IMAGE="$2"; shift 2 ;;
    --lang) shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; fail "不认识的参数：$1" "Unknown option: $1" ;;
  esac
done
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  fail "端口要是 1 到 65535 的整数" "The port must be an integer from 1 to 65535"
fi
if [[ -n "$PROXY_HOPS" ]]; then
  [[ "$PROXY_HOPS" =~ ^[0-5]$ ]] ||
    fail "反向代理的层数要是 0 到 5 的整数" "The number of reverse proxies must be an integer from 0 to 5"
fi
[[ "$DATA_DIR" == /* ]] || fail "数据目录要写绝对路径" "The data directory must be an absolute path"
SITE_IMAGE="${SITE_IMAGE:-$SITE_IMAGE_DEFAULT}"

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

printf '\n%s%sSeekCloud%s\n' "$BOLD" "$BLUE" "$RESET"
info "安装主站：主站、PostgreSQL$( ((WITH_CADDY)) && printf '、Caddy')，数据放在 $DATA_DIR。" \
  "Installing the main site: site, PostgreSQL$( ((WITH_CADDY)) && printf ', Caddy'). Data goes to $DATA_DIR."

# ── 1. 检查系统 ──────────────────────────────────────────────────────────

stage "检查系统" "Checking the system"
[[ $EUID -eq 0 ]] || fail "请用 root 运行：sudo bash $0" "Please run as root: sudo bash $0"

# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-}"
OS_VERSION="${VERSION_ID:-}"
OS_CODENAME="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"
case "$OS_ID $OS_VERSION" in
  "ubuntu 22.04" | "ubuntu 24.04" | "debian 12") ok "系统：${PRETTY_NAME:-$OS_ID $OS_VERSION}" "System: ${PRETTY_NAME:-$OS_ID $OS_VERSION}" ;;
  *) fail "不支持这个系统（${PRETTY_NAME:-未知}）。支持 Ubuntu 22.04、24.04 和 Debian 12。" \
    "This system is not supported (${PRETTY_NAME:-unknown}). Supported: Ubuntu 22.04, 24.04 and Debian 12." ;;
esac

ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64 | arm64) ok "架构：$ARCH" "Architecture: $ARCH" ;;
  *) fail "不支持这个架构（$ARCH），只支持 amd64 和 arm64。" "This architecture ($ARCH) is not supported. Only amd64 and arm64 are." ;;
esac

# 容器式的 VPS（LXC、OpenVZ）装得了主站，但当不了沙箱宿主机（沙箱要 Sysbox，得是完整的虚拟机）
container=""
if command -v systemd-detect-virt >/dev/null 2>&1; then
  container=$(systemd-detect-virt --container 2>/dev/null || true)
  [[ "$container" == "none" ]] && container=""
fi
if [[ -z "$container" ]]; then
  if [[ -e /proc/user_beancounters || -d /proc/vz ]]; then container="openvz"
  elif grep -qa 'container=lxc' /proc/1/environ 2>/dev/null; then container="lxc"
  elif [[ -e /.dockerenv ]]; then container="docker"; fi
fi
if [[ -n "$container" ]]; then
  warn "这台机器是容器（$container）：主站照样能装，但这台机器不能当沙箱宿主机。" \
    "This machine is a container ($container): the main site installs fine, but this machine cannot be a sandbox host."
fi

mem_mb=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo)
if ((mem_mb < 1000)); then
  warn "内存只有 ${mem_mb} MB，可能不够（建议至少 1 GB）。" "Only ${mem_mb} MB of memory; it may not be enough (at least 1 GB is recommended)."
else
  ok "内存：${mem_mb} MB" "Memory: ${mem_mb} MB"
fi
probe_dir="$DATA_DIR"
while [[ ! -d "$probe_dir" ]]; do probe_dir=$(dirname "$probe_dir"); done
disk_gb=$(df -Pk "$probe_dir" | awk 'NR == 2 { printf "%d", $4 / 1048576 }')
if ((disk_gb < 2)); then
  fail "$probe_dir 所在的磁盘只剩 ${disk_gb} GB，放不下镜像。" "Only ${disk_gb} GB free on the disk holding $probe_dir; the images will not fit."
elif ((disk_gb < 10)); then
  warn "$probe_dir 所在的磁盘只剩 ${disk_gb} GB，建议至少 10 GB。" "Only ${disk_gb} GB free on the disk holding $probe_dir; at least 10 GB is recommended."
else
  ok "磁盘：剩 ${disk_gb} GB" "Disk: ${disk_gb} GB free"
fi

# ── 2. Docker Engine ─────────────────────────────────────────────────────

stage "Docker Engine" "Docker Engine"

# apt 的输出只在出错时显示
quiet() {
  local log
  log=$(mktemp)
  if ! "$@" >"$log" 2>&1; then
    sed 's/^/    /' "$log" >&2
    rm -f "$log"
    fail "执行失败：$*" "Command failed: $*"
  fi
  rm -f "$log"
}
apt_ready=0
apt_prepare() {
  ((apt_ready)) && return 0
  info "更新软件包列表" "Updating the package lists"
  quiet apt-get update
  quiet apt-get install -y ca-certificates curl gnupg iproute2
  apt_ready=1
}

# 加上 Docker 的 apt 源：按顺序试官方和镜像，签名密钥核对官方的指纹
add_docker_repo() {
  [[ -f /etc/apt/sources.list.d/docker.list ]] && return 0
  apt_prepare
  install -m 0755 -d /etc/apt/keyrings
  local base key fingerprint
  for base in "${DOCKER_APT_SOURCES[@]}"; do
    key=$(mktemp)
    if curl -fsSL --connect-timeout 10 --max-time 60 "$base/linux/$OS_ID/gpg" -o "$key" 2>/dev/null; then
      fingerprint=$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '/^fpr:/ { print $10; exit }')
      if [[ "$fingerprint" == "$DOCKER_GPG_FINGERPRINT" ]]; then
        install -m 0644 "$key" /etc/apt/keyrings/docker.asc
        rm -f "$key"
        echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] $base/linux/$OS_ID $OS_CODENAME stable" \
          >/etc/apt/sources.list.d/docker.list
        if apt-get update >/dev/null 2>&1; then
          ok "Docker 的软件源：$base" "Docker package source: $base"
          return 0
        fi
        rm -f /etc/apt/sources.list.d/docker.list
      else
        warn "$base 的签名密钥和 Docker 官方的指纹对不上，跳过" "The signing key from $base does not match Docker's fingerprint; skipped"
      fi
    fi
    rm -f "$key"
    note "$base 连不上，换下一个" "$base is unreachable; trying the next one"
  done
  fail "Docker 的软件源都连不上。请检查网络，或者先自己装好 Docker Engine 再运行这个脚本。" \
    "None of Docker's package sources are reachable. Check the network, or install Docker Engine yourself and run this script again."
}

if docker info >/dev/null 2>&1; then
  ok "已经装好：Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)" \
    "Already installed: Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
elif [[ -S /var/run/docker.sock ]] && command -v docker >/dev/null 2>&1; then
  fail "Docker 装了但连不上（docker info 失败）。请先让 Docker 能用，再运行这个脚本。" \
    "Docker is installed but not responding (docker info failed). Get Docker working, then run this script again."
elif [[ -S /var/run/docker.sock ]]; then
  # 已经有 Docker 守护进程（比如在容器里用宿主的），只缺命令行
  add_docker_repo
  quiet apt-get install -y docker-ce-cli docker-compose-plugin
  docker info >/dev/null 2>&1 || fail "装好了命令行，但连不上 Docker。" "The Docker CLI is installed, but Docker is not responding."
  ok "装好了 Docker 的命令行" "Installed the Docker CLI"
else
  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
    fail "系统里有 snap 装的 Docker。请先删掉它（snap remove docker），再运行这个脚本。" \
      "Docker is installed as a snap. Remove it first (snap remove docker), then run this script again."
  fi
  info "从 Docker 的软件源安装，大约一两分钟" "Installing from Docker's package source; this takes a minute or two"
  add_docker_repo
  quiet apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
  if [[ -d /run/systemd/system ]]; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
  docker info >/dev/null 2>&1 || fail "Docker 装好了但起不来。请看 journalctl -u docker 的输出。" \
    "Docker was installed but does not start. See the output of journalctl -u docker."
  ok "装好了：Docker $(docker version --format '{{.Server.Version}}')" "Installed: Docker $(docker version --format '{{.Server.Version}}')"
fi
if ! docker compose version >/dev/null 2>&1; then
  add_docker_repo
  quiet apt-get install -y docker-compose-plugin
fi
ok "Docker Compose $(docker compose version --short)" "Docker Compose $(docker compose version --short)"
# 后面要用 ss 查端口、curl 测镜像站
if ! command -v ss >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then apt_prepare; fi

# ── 3. 端口 ──────────────────────────────────────────────────────────────

stage "检查端口" "Checking ports"
PROJECT="seekcloud"
our_container() {
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1"
}
port_owner() {
  ss -ltnpH "( sport = :$1 )" 2>/dev/null | head -n1 | grep -o 'users:(([^)]*' | sed 's/users:((//' || true
}
port_busy() { [[ -n "$(ss -ltnH "( sport = :$1 )" 2>/dev/null)" ]]; }
if ((WITH_CADDY)); then
  if [[ -n "$(our_container caddy)" ]]; then
    ok "80 和 443 端口由已经装好的 Caddy 在用" "Ports 80 and 443 are used by the Caddy installed earlier"
  else
    for port in 80 443; do
      if port_busy "$port"; then
        fail "$port 端口已经被占用（$(port_owner "$port")）。已经有反向代理时，加参数 --no-caddy 不装 Caddy，再让你的反向代理转到主站。" \
          "Port $port is already in use ($(port_owner "$port")). If you already have a reverse proxy, add --no-caddy and point your proxy at the site."
      fi
    done
    ok "80 和 443 端口空着" "Ports 80 and 443 are free"
  fi
else
  if [[ -n "$(our_container site)" ]] || ! port_busy "$PORT"; then
    ok "主站监听 127.0.0.1:$PORT" "The site will listen on 127.0.0.1:$PORT"
  else
    fail "$PORT 端口已经被占用（$(port_owner "$PORT")）。用 --port 换一个端口。" \
      "Port $PORT is already in use ($(port_owner "$PORT")). Choose another one with --port."
  fi
fi

# ── 4. 目录和密钥 ────────────────────────────────────────────────────────

stage "目录和密钥" "Directories and secrets"
umask 077
install -d -m 0700 "$DATA_DIR"
install -d -m 0700 "$DATA_DIR/postgres" "$DATA_DIR/caddy" "$DATA_DIR/caddy/data" "$DATA_DIR/caddy/config"
# 主站在容器里以 node 用户（uid 1000）运行，它的数据目录归它
install -d -m 0700 -o 1000 -g 1000 "$DATA_DIR/site"

SITE_ENV="$DATA_DIR/site.env"
POSTGRES_ENV="$DATA_DIR/postgres.env"
env_value() {
  if [[ -f "$1" ]]; then grep -m1 "^$2=" "$1" | cut -d= -f2- || true; fi
}
random_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

db_password=$(env_value "$POSTGRES_ENV" POSTGRES_PASSWORD)
if [[ -z "$db_password" ]]; then
  # 库已经建好、密码文件却没了：再生成一个也连不上原来的库，不能乱来
  if [[ -n "$(ls -A "$DATA_DIR/postgres" 2>/dev/null)" ]]; then
    fail "$DATA_DIR/postgres 里已经有数据库，但 $POSTGRES_ENV 不见了，不知道它的密码。请从备份里找回这个文件。" \
      "$DATA_DIR/postgres already holds a database, but $POSTGRES_ENV is missing, so its password is unknown. Restore that file from a backup."
  fi
  db_password=$(random_hex 24)
  ok "生成了数据库密码" "Generated the database password"
else
  ok "沿用已有的数据库密码" "Keeping the existing database password"
fi

secret_key=$(env_value "$SITE_ENV" SEEKCLOUD_SECRET_KEY)
if [[ -z "$secret_key" ]]; then
  if [[ -n "$(ls -A "$DATA_DIR/postgres" 2>/dev/null)" ]]; then
    fail "已经有数据，但 $SITE_ENV 里没有 SEEKCLOUD_SECRET_KEY。换了密钥，库里加密的令牌和 key 都会作废。请从备份里找回这个文件。" \
      "Data already exists, but $SITE_ENV has no SEEKCLOUD_SECRET_KEY. With a new key, the encrypted tokens and keys in the database become unusable. Restore that file from a backup."
  fi
  secret_key=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
  ok "生成了 SEEKCLOUD_SECRET_KEY" "Generated SEEKCLOUD_SECRET_KEY"
  warn "SEEKCLOUD_SECRET_KEY 在 $SITE_ENV 里，备份里不含它：请另外保存这个文件。" \
    "SEEKCLOUD_SECRET_KEY is in $SITE_ENV and is not part of backups: keep a separate copy of this file."
else
  ok "沿用已有的 SEEKCLOUD_SECRET_KEY" "Keeping the existing SEEKCLOUD_SECRET_KEY"
fi

hops="$PROXY_HOPS"
[[ -z "$hops" ]] && hops=$(env_value "$SITE_ENV" SEEKCLOUD_PROXY_HOPS)
# 装 Caddy 时前面是 Caddy 一层；不装时主站只听 127.0.0.1，前面是管理员自己的反向代理，也是一层
[[ -z "$hops" ]] && hops=1

# 密钥只写进只有 root 能读的文件，不打印、不进日志
write_secret_file() {
  local file="$1" tmp
  tmp=$(mktemp "$DATA_DIR/.tmp.XXXXXX")
  cat >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}
write_secret_file "$POSTGRES_ENV" <<EOF
POSTGRES_PASSWORD=$db_password
EOF
write_secret_file "$SITE_ENV" <<EOF
DATABASE_URL=postgres://seekcloud:$db_password@postgres:5432/seekcloud
SEEKCLOUD_SECRET_KEY=$secret_key
SEEKCLOUD_PROXY_HOPS=$hops
EOF
unset db_password secret_key
ok "密钥写在 $SITE_ENV 和 $POSTGRES_ENV（只有 root 能读）" "Secrets are in $SITE_ENV and $POSTGRES_ENV (readable by root only)"

# ── 5. 镜像 ──────────────────────────────────────────────────────────────

stage "拉取镜像" "Pulling images"

# 一个镜像仓库通不通、多快：访问 /v2/，回 200 或 401 都算通，取总耗时（秒）
registry_latency() {
  local code time
  read -r code time < <(curl -s -o /dev/null -m 5 -w '%{http_code} %{time_total}\n' "https://$1/v2/" 2>/dev/null || echo "000 0")
  [[ "$code" == "200" || "$code" == "401" ]] && printf '%s %s\n' "$time" "$1"
  return 0
}

# 按快慢排好的候选：默认仓库加上公开的镜像站，测不通的跳过
ranked_registries() {
  local default="$1"; shift
  local host
  for host in "$default" "$@"; do registry_latency "$host"; done | sort -n | awk '{ print $2 }'
}

# pull_image 镜像 仓库 路径：镜像已经在本机就不拉；否则按快慢一个个试，拉到以后打上原来的名字
pull_image() {
  local ref="$1" source="$2" path="$3" host candidates=() mirror
  if docker image inspect "$ref" >/dev/null 2>&1; then
    ok "$ref（本机已有）" "$ref (already present)"
    return 0
  fi
  if [[ -n "$REGISTRY" ]]; then
    candidates=("$REGISTRY")
  elif [[ "$source" == "docker.io" ]]; then
    mapfile -t candidates < <(ranked_registries registry-1.docker.io "${DOCKERHUB_MIRRORS[@]}")
  elif [[ "$source" == "ghcr.io" ]]; then
    mapfile -t candidates < <(ranked_registries ghcr.io "${GHCR_MIRRORS[@]}")
  else
    candidates=("$source")
  fi
  # 最后照原名拉一次：管理员在 /etc/docker/daemon.json 里配的镜像加速对它生效
  [[ -z "$REGISTRY" ]] && candidates+=("(daemon)")
  for host in "${candidates[@]}"; do
    case "$host" in
      registry-1.docker.io | "$source" | "(daemon)") mirror="$ref" ;;
      *) mirror="$host/$path" ;;
    esac
    if [[ "$host" == "(daemon)" ]]; then
      info "按 Docker 自己的设置拉取 $ref" "Pulling $ref with Docker's own settings"
    else
      info "从 $host 拉取 $ref" "Pulling $ref from $host"
    fi
    if timeout 1800 docker pull -q "$mirror" >/dev/null 2>&1; then
      [[ "$mirror" != "$ref" ]] && docker tag "$mirror" "$ref"
      ok "$ref" "$ref"
      return 0
    fi
    note "$host 拉不动，换下一个" "Could not pull from $host; trying the next one"
  done
  printf '\n'
  warn "$ref 拉不下来。可以给 Docker 配镜像加速，写进 /etc/docker/daemon.json：" \
    "Could not pull $ref. You can configure a registry mirror for Docker in /etc/docker/daemon.json:"
  printf '\n    {\n      "registry-mirrors": ["https://<镜像加速地址>"]\n    }\n\n'
  info "然后运行 systemctl restart docker，再运行这个脚本；或者用 --registry 指定一个镜像站。" \
    "Then run systemctl restart docker and run this script again, or pick a mirror with --registry."
  exit 1
}

# 镜像名拆成仓库和路径：postgres:16-alpine → docker.io library/postgres:16-alpine
split_ref() {
  local ref="$1" first="${1%%/*}"
  if [[ "$ref" != */* ]]; then printf 'docker.io library/%s\n' "$ref"
  elif [[ "$first" == *.* || "$first" == *:* || "$first" == localhost ]]; then printf '%s %s\n' "$first" "${ref#*/}"
  else printf 'docker.io %s\n' "$ref"; fi
}

images=("$SITE_IMAGE" "$POSTGRES_IMAGE")
((WITH_CADDY)) && images+=("$CADDY_IMAGE")
for image in "${images[@]}"; do
  read -r source path < <(split_ref "$image")
  pull_image "$image" "$source" "$path"
done

# ── 6. Compose 文件 ──────────────────────────────────────────────────────

stage "写 Compose 文件" "Writing the Compose file"
umask 022
{
  cat <<EOF
# 由 SeekCloud 的安装脚本生成，重新运行安装脚本会覆盖。
# Generated by the SeekCloud installer; re-running the installer overwrites it.
name: $PROJECT

services:
  postgres:
    image: $POSTGRES_IMAGE
    restart: unless-stopped
    env_file: [postgres.env]
    environment:
      POSTGRES_USER: seekcloud
      POSTGRES_DB: seekcloud
    volumes:
      - ./postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U seekcloud -d seekcloud"]
      interval: 5s
      timeout: 5s
      retries: 30
    # 数据库只在内部网络里，不映射端口
    networks: [backend]

  site:
    image: $SITE_IMAGE
    restart: unless-stopped
    env_file: [site.env]
    volumes:
      - ./site:/data
    depends_on:
      postgres:
        condition: service_healthy
    # backend 连数据库，frontend 连 Caddy 和外网（GitHub、模型提供方）
    networks: [backend, frontend]
EOF
  if ((!WITH_CADDY)); then
    cat <<EOF
    # 不装 Caddy：只对本机开放，由管理员自己的反向代理转过来
    ports:
      - "127.0.0.1:$PORT:3000"
EOF
  fi
  if ((WITH_CADDY)); then
    cat <<EOF

  caddy:
    image: $CADDY_IMAGE
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/data:/data
      - ./caddy/config:/config
    depends_on: [site]
    networks: [frontend]
EOF
  fi
  cat <<EOF

networks:
  backend:
    internal: true
  frontend: {}
EOF
} >"$DATA_DIR/compose.yml"
if ((WITH_CADDY)); then
  # 先用 http://服务器地址 打开；在部署向导里填了域名以后再申请证书（#96）
  cat >"$DATA_DIR/Caddyfile" <<'EOF'
# 由 SeekCloud 的安装脚本生成，重新运行安装脚本会覆盖。
# Generated by the SeekCloud installer; re-running the installer overwrites it.
:80 {
	reverse_proxy site:3000
}
EOF
fi
ok "$DATA_DIR/compose.yml" "$DATA_DIR/compose.yml"

# ── 7. 启动 ──────────────────────────────────────────────────────────────

stage "启动" "Starting"
compose() { docker compose -f "$DATA_DIR/compose.yml" --project-directory "$DATA_DIR" "$@"; }
compose --progress quiet up -d --remove-orphans ||
  fail "启动失败，上面是 Docker Compose 的输出。" "Starting failed; the Docker Compose output is above."
info "等主站的健康检查通过" "Waiting for the site's health check"
site_id=$(compose ps -q site)
status=""
for _ in $(seq 1 90); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$site_id" 2>/dev/null || true)
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
if [[ "$status" != "healthy" ]]; then
  compose logs --tail 40 site 2>&1 | sed 's/^/    /'
  fail "主站没有通过健康检查。上面是它最近的日志；也可以运行 docker compose -f $DATA_DIR/compose.yml logs site 查看。" \
    "The site did not pass its health check. Its recent logs are above; you can also run docker compose -f $DATA_DIR/compose.yml logs site."
fi
ok "主站起来了" "The site is up"
if ((WITH_CADDY)); then
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null -m 5 http://127.0.0.1/api/health 2>/dev/null && break
    sleep 1
  done
  curl -fsS -o /dev/null -m 5 http://127.0.0.1/api/health ||
    fail "主站起来了，但经 Caddy 访问不通。请运行 docker compose -f $DATA_DIR/compose.yml logs caddy 查看。" \
      "The site is up, but it is not reachable through Caddy. Run docker compose -f $DATA_DIR/compose.yml logs caddy to see why."
  ok "经 Caddy 访问正常" "Reachable through Caddy"
fi

# ── 完成 ─────────────────────────────────────────────────────────────────

# 还没设置管理员密码时，/api/me 回 setup_required
if ((WITH_CADDY)); then site_url="http://127.0.0.1"; else site_url="http://127.0.0.1:$PORT"; fi
needs_setup=0
if curl -s -m 5 "$site_url/api/me" 2>/dev/null | grep -q '"setup_required"'; then needs_setup=1; fi

address=$(hostname -I 2>/dev/null | awk '{ print $1 }')
printf '\n%s%s  ✓ %s%s\n\n' "$BOLD" "$GREEN" "$(pick "装好了" "Installed")" "$RESET"
if ((WITH_CADDY)); then
  info "网页地址：${BOLD}http://${address:-<服务器地址>}/${RESET}" "Web address: ${BOLD}http://${address:-<server address>}/${RESET}"
  note "服务器在 NAT 后面时，用它的公网地址；防火墙要放行 80 和 443 端口。" \
    "If the server is behind NAT, use its public address. The firewall must allow ports 80 and 443."
else
  info "主站监听 ${BOLD}http://127.0.0.1:$PORT${RESET}，请让你的反向代理转到这个地址。" \
    "The site listens on ${BOLD}http://127.0.0.1:$PORT${RESET}. Point your reverse proxy at it."
  note "反向代理要把客户端地址追加到 X-Forwarded-For；前面不止一层时用 --proxy-hops 改层数。" \
    "Your proxy must append the client address to X-Forwarded-For; if there is more than one proxy, set the number with --proxy-hops."
fi
printf '\n'
if ((needs_setup)); then
  warn "请立即打开网页设置管理员密码：设置之前，任何打开这个地址的人都能成为管理员。" \
    "Open the web page and set the admin password right away: until then, anyone who opens this address can become the admin."
else
  ok "管理员密码已经设置过" "The admin password is already set"
fi
printf '\n'
note "数据和密钥在 $DATA_DIR；请另外保存 $SITE_ENV（里面的 SEEKCLOUD_SECRET_KEY 不在备份里）。" \
  "Data and secrets are in $DATA_DIR. Keep a separate copy of $SITE_ENV (its SEEKCLOUD_SECRET_KEY is not part of backups)."
note "忘记管理员密码时：docker compose -f $DATA_DIR/compose.yml exec site node dist/server/reset-password.js" \
  "If you forget the admin password: docker compose -f $DATA_DIR/compose.yml exec site node dist/server/reset-password.js"
printf '\n'
