import type { networkAccess } from "../db/schema";

/** 环境的网络策略（GLOSSARY："网络策略"）：不开放、默认清单、自定义、完全开放。 */
export type NetworkAccess = (typeof networkAccess.enumValues)[number];

/**
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

export type FetchDecision = { ok: true } | { ok: false; message: string };

/**
 * 网页抓取受不受环境的网络策略约束，要用户定（docs/roadmap/2026-11-15-review.md 第六节第 1 条）。
 * 定下来之前照最保守的做（#26 的 2026-11-15 评论）：不开放档一律拒绝；默认清单档只放行默认清单里的域名；
 * 自定义档只放行环境自己的清单（填清单的地方在 #47 里做，现在是空的）；完全开放档不限。
 * 不管哪一档，内网和本机地址都不连（address.ts）。
 */
export function webFetchDecision(
  access: NetworkAccess,
  host: string,
  custom: readonly string[] = [],
): FetchDecision {
  const name = normalizeHost(host) ?? host;
  switch (access) {
    case "full":
      return { ok: true };
    case "none":
      return {
        ok: false,
        message:
          "这个会话所用环境的网络策略是“不开放”，不能抓取网页。需要的话请管理员修改环境的网络策略。",
      };
    case "default":
      return DEFAULT_ALLOWLIST.some((p) => matchesDomain(p, name))
        ? { ok: true }
        : {
            ok: false,
            message: `这个会话所用环境的网络策略是“默认清单”，${name} 不在清单里，不能抓取。需要的话请管理员修改环境的网络策略。`,
          };
    case "custom":
      return custom.some((p) => matchesDomain(p, name))
        ? { ok: true }
        : {
            ok: false,
            message: `这个会话所用环境的网络策略是“自定义”，${name} 不在环境的清单里，不能抓取。需要的话请管理员修改环境的网络策略。`,
          };
  }
}
