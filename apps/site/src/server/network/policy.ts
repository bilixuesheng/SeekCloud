import type { networkAccess } from "../db/schema";

/** 环境的网络策略（GLOSSARY："网络策略"）：不开放、默认清单、自定义、完全开放。 */
export type NetworkAccess = (typeof networkAccess.enumValues)[number];

/**
 * 网络策略的域名清单，给出站代理用（#47）。网页抓取不受网络策略约束（2026-11-18 用户定的，照 Claude Code），不用这里。
 *
 * 默认清单（#47）：各语言的包仓库、系统软件源、Docker Hub、GitHub 的公开下载地址、常用的大陆镜像源。
 * `*.example.com` 只匹配子域名，不匹配 example.com 本身，所以两个都要的时候都写上。
 * 以后在设置的"网络"一类里维护（#47），这里是默认值。
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  // GitHub
  "github.com",
  "*.github.com",
  "githubusercontent.com",
  "*.githubusercontent.com",
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
  // JavaScript
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "nodejs.org",
  "deno.land",
  "jsr.io",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // Rust
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "static.rust-lang.org",
  "sh.rustup.rs",
  // Go
  "proxy.golang.org",
  "sum.golang.org",
  "go.dev",
  "dl.google.com",
  // Ruby
  "rubygems.org",
  "index.rubygems.org",
  // Java、Kotlin
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "services.gradle.org",
  // PHP
  "packagist.org",
  "repo.packagist.org",
  // .NET
  "api.nuget.org",
  // Dart
  "pub.dev",
  // Docker
  "docker.io",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
  // 系统软件源
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
  "deb.debian.org",
  "security.debian.org",
  "dl-cdn.alpinelinux.org",
  // 大陆的镜像源
  "mirrors.aliyun.com",
  "mirrors.tuna.tsinghua.edu.cn",
  "pypi.tuna.tsinghua.edu.cn",
  "mirrors.ustc.edu.cn",
  "mirrors.cloud.tencent.com",
  "repo.huaweicloud.com",
  "registry.npmmirror.com",
  "npmmirror.com",
  "goproxy.cn",
];

/** 域名规整成比较用的样子：小写、去掉末尾的点、国际化域名转成 punycode。不是合法的域名时返回 undefined。 */
export function normalizeHost(host: string): string | undefined {
  let text = host.trim().toLowerCase();
  if (text.endsWith(".")) text = text.slice(0, -1);
  if (!text || text.length > 253 || /[/\\?#@\s]/.test(text)) return undefined;
  try {
    return new URL(`http://${text}`).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 一条清单匹配不匹配这个域名。按完整的域名比较（#47）：`*.example.com` 匹配 a.example.com、a.b.example.com，
 * 不匹配 example.com，也不匹配 example.com.evil.net、evilexample.com。大小写、末尾的点规整后再比。
 */
export function matchesDomain(pattern: string, host: string): boolean {
  const wildcard = pattern.trim().startsWith("*.");
  const base = normalizeHost(wildcard ? pattern.trim().slice(2) : pattern);
  const target = normalizeHost(host);
  if (!base || !target) return false;
  return wildcard ? target.endsWith(`.${base}`) : target === base;
}
