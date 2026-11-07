import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RecordedRequest {
  host: "github.com" | "api.github.com";
  method: string;
  path: string;
  authorization?: string;
  body: string;
}

/** 测试里跑 git 用的环境：不读这台机器的全局 git 配置，也不走这台机器的代理。 */
export function cleanGitEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/proxy|^GIT_|^GH_|^GITHUB_|SSL_CERT|CA_CERT|CAINFO/i.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "测试",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "测试",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...extra,
  };
}

/**
 * 假 GitHub：git 部分是真的 git http-backend（裸仓库放在临时目录里），REST 部分记下收到的请求。
 * 只认一个用户令牌；不对就返回 401，和真的 GitHub 一样。
 */
export async function startFakeGitHub(userToken: string) {
  const root = mkdtempSync(join(tmpdir(), "fake-github-"));
  const requests: RecordedRequest[] = [];
  const expectedGitAuth = `Basic ${Buffer.from(`x-access-token:${userToken}`).toString("base64")}`;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");
    const [, prefix, ...rest] = url.pathname.split("/");
    const path = `/${rest.join("/")}`;
    const host = prefix === "api" ? "api.github.com" : "github.com";
    requests.push({
      host,
      method: req.method ?? "GET",
      path,
      authorization: req.headers.authorization,
      body: body.toString(),
    });

    if (host === "api.github.com") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path }));
      return;
    }
    if (req.headers.authorization !== expectedGitAuth) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
      res.end("bad credentials");
      return;
    }
    // CGI：把请求交给 git http-backend。
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "x-access-token",
      PATH_INFO: path,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
    };
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") env[`HTTP_${name.toUpperCase().replace(/-/g, "_")}`] = value;
    }
    const cgi = spawn("git", ["http-backend"], { env });
    const out: Buffer[] = [];
    cgi.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    cgi.stdin.end(body);
    cgi.on("close", () => {
      const raw = Buffer.concat(out);
      const split = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, split).toString().split("\r\n");
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head) {
        const [name = "", ...value] = line.split(": ");
        if (name.toLowerCase() === "status") status = Number.parseInt(value.join(": "), 10);
        else headers[name] = value.join(": ");
      }
      res.writeHead(status, headers);
      res.end(raw.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    root,
    requests,
    upstreams: { "github.com": `${base}/github`, "api.github.com": `${base}/api` },
    /** 建一个裸仓库，main 上有 commits 个提交。 */
    createRepo(fullName: string, commits = 3) {
      const bare = join(root, `${fullName}.git`);
      mkdirSync(bare, { recursive: true });
      execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
      const work = mkdtempSync(join(tmpdir(), "seed-"));
      const env = cleanGitEnv(work);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env });
      git("init", "-q", "-b", "main");
      for (let i = 1; i <= commits; i++) git("commit", "-q", "--allow-empty", "-m", `提交 ${i}`);
      git("push", "-q", bare, "main");
    },
    /** 裸仓库里的引用。 */
    refs(fullName: string): string {
      return execFileSync("git", ["for-each-ref", "--format=%(refname)"], {
        cwd: join(root, `${fullName}.git`),
      }).toString();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
