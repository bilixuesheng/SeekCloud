#!/bin/bash
# 装某个大版本里最新的 Node 官方二进制包：install-node.sh <大版本> <装到哪个目录>。
# 按 nodejs.org 同一个目录里的 SHASUMS256.txt 核对。
set -euo pipefail
major="$1"
prefix="$2"
case "$(dpkg --print-architecture)" in
  amd64) arch=x64 ;;
  arm64) arch=arm64 ;;
  *) echo "不支持的架构" >&2; exit 1 ;;
esac
base="https://nodejs.org/dist/latest-v${major}.x"
work="$(mktemp -d)"
cd "$work"
curl -fsSLO "${base}/SHASUMS256.txt"
file="$(grep -oE "node-v[0-9.]+-linux-${arch}\.tar\.xz" SHASUMS256.txt | head -n 1)"
curl -fsSLO "${base}/${file}"
grep " ${file}\$" SHASUMS256.txt | sha256sum -c -
mkdir -p "$prefix"
tar -xJf "$file" -C "$prefix" --strip-components=1 --no-same-owner
rm -rf "$work" "$prefix"/{CHANGELOG.md,LICENSE,README.md}
"$prefix/bin/node" --version
