import { execFile, execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSigningKey } from "../signing/sshsig";
import { cleanGitEnv, startFakeGitHub } from "../testing/fake-github";
import { ProxyCa } from "./ca";
import { createGitProxy, TOKEN_PLACEHOLDER } from "./proxy";
import { GitSessions } from "./sessions";

const USER_TOKEN = "gho_user_token";
const SESSION_TOKEN = "sess_abc123";
const SIGNER = resolve(__dirname, "../../sandbox/seekcloud-sign");
const BOT_EMAIL = "bot@seekcloud.test";

let github: Awaited<ReturnType<typeof startFakeGitHub>>;
let proxy: http.Server;
let proxyUrl: string;
let ca: ProxyCa;
const sessions = new GitSessions();
const signingKey = loadSigningKey(
  generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  "seekcloud-bot",
);

beforeAll(async () => {
  github = await startFakeGitHub(USER_TOKEN);
  github.createRepo("octo/app", 60);
  github.createRepo("someone/lib");
  github.createRepo("other/secret");
  ca = new ProxyCa(mkdtempSync(join(tmpdir(), "proxy-ca-")));
  proxy = createGitProxy({
    sessions,
    ca,
    signingKey,
    signerEmail: BOT_EMAIL,
    upstreams: github.upstreams,
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  sessions.register({
    sessionId: "s1",
    sessionToken: SESSION_TOKEN,
    repos: [
      { fullName: "octo/app", access: "push" },
      { fullName: "someone/lib", access: "read" },
    ],
  });
  sessions.setGitHubToken("s1", USER_TOKEN);
});

afterAll(async () => {
  await new Promise<void>((done) => proxy.close(() => done()));
  await github.close();
});

/**
 * 沙箱里的 git：代理凭据是会话令牌，没有任何 GitHub 令牌。
 * 必须异步跑：代理和假 GitHub 就在这个进程里，同步等 git 会把它们卡住。
 */
function sandboxGit(
  cwd: string,
  args: string[],
  token = SESSION_TOKEN,
): Promise<{ ok: boolean; output: string }> {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  writeFileSync(join(home, "ca.crt"), ca.certPem);
  const proxyWithCreds = proxyUrl.replace("http://", `http://session:${token}@`);
  const env = cleanGitEnv(home, { GIT_SSL_CAINFO: join(home, "ca.crt") });
  return new Promise((done) => {
    execFile(
      "git",
      ["-c", `http.proxy=${proxyWithCreds}`, "-c", "http.proxyAuthMethod=basic", ...args],
      { cwd, env },
      (error, stdout, stderr) => done({ ok: !error, output: `${stdout}${stderr}` }),
    );
  });
}

/** 用代理发一个 REST 请求（明文代理请求，gh 走 HTTPS 时也是同样的规则）。 */
function rest(method: string, path: string, init: { auth?: string; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((done, fail) => {
    const req = http.request(
      proxyUrl,
      {
        method,
        path: `http://api.github.com${path}`,
        headers: {
          "proxy-authorization": `Basic ${Buffer.from(`session:${SESSION_TOKEN}`).toString("base64")}`,
          authorization: init.auth ?? `token ${TOKEN_PLACEHOLDER}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", fail);
    req.end(init.body);
  });
}

const tmp = () => mkdtempSync(join(tmpdir(), "work-"));

describe("沙箱经 Git 代理拉取和推送", () => {
  it("浅克隆本会话的仓库（50 个提交）：GitHub 收到的是用户的令牌，沙箱里没有令牌", async () => {
    const dir = tmp();
    const clone = await sandboxGit(dir, [
      "clone",
      "-q",
      "--depth",
      "50",
      "http://github.com/octo/app.git",
      "app",
    ]);
    expect(clone.output).toBe("");
    expect(clone.ok).toBe(true);
    const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: join(dir, "app") });
    expect(count.toString().trim()).toBe("50");
    const auths = github.requests
      .filter((r) => r.host === "github.com")
      .map((r) => r.authorization);
    expect(new Set(auths)).toEqual(
      new Set([`Basic ${Buffer.from(`x-access-token:${USER_TOKEN}`).toString("base64")}`]),
    );
  });

  it("经过 HTTPS（代理用自己的 CA 解密）也能克隆", async () => {
    const clone = await sandboxGit(tmp(), [
      "clone",
      "-q",
      "https://github.com/octo/app.git",
      "app",
    ]);
    expect(clone.output).toBe("");
    expect(clone.ok).toBe(true);
  });

  it("推送新分支、任意分支强推都放行", async () => {
    const dir = tmp();
    await sandboxGit(dir, ["clone", "-q", "http://github.com/octo/app.git", "app"]);
    const app = join(dir, "app");
    const git = (...args: string[]) => sandboxGit(app, args);
    await git("commit", "-q", "--allow-empty", "-m", "新功能");
    expect((await git("push", "-q", "origin", "HEAD:refs/heads/seekcloud/abc")).ok).toBe(true);
    await git("reset", "-q", "--hard", "HEAD~2");
    expect((await git("push", "-q", "--force", "origin", "HEAD:main")).ok).toBe(true);
    expect(github.refs("octo/app")).toContain("refs/heads/seekcloud/abc");
  });

  it("删除分支、推送标签被拒绝，git 显示原因，GitHub 上什么都没变", async () => {
    const dir = tmp();
    await sandboxGit(dir, ["clone", "-q", "http://github.com/octo/app.git", "app"]);
    const app = join(dir, "app");
    const before = github.refs("octo/app");

    const del = await sandboxGit(app, ["push", "origin", "--delete", "seekcloud/abc"]);
    expect(del.ok).toBe(false);
    expect(del.output).toContain("代理不放行删除分支");

    await sandboxGit(app, ["tag", "v1.0"]);
    const tag = await sandboxGit(app, ["push", "origin", "v1.0"]);
    expect(tag.ok).toBe(false);
    expect(tag.output).toContain("代理不放行创建或推送标签");

    expect(github.refs("octo/app")).toBe(before);
  });

  it("没挂载的仓库：拒绝，并说明原因", async () => {
    const clone = await sandboxGit(tmp(), ["clone", "-q", "http://github.com/other/secret.git"]);
    expect(clone.ok).toBe(false);
    expect(clone.output).toContain("没有挂载到当前会话");
  });

  it("只读挂载的仓库：能拉，不能推", async () => {
    const dir = tmp();
    expect(
      (await sandboxGit(dir, ["clone", "-q", "http://github.com/someone/lib.git", "lib"])).ok,
    ).toBe(true);
    const push = await sandboxGit(join(dir, "lib"), ["push", "origin", "HEAD:refs/heads/x"]);
    expect(push.ok).toBe(false);
    expect(push.output).toContain("只读挂载");
  });

  it("会话令牌不对（比如会话已经结束）：代理不放行", async () => {
    const clone = await sandboxGit(
      tmp(),
      ["clone", "-q", "http://github.com/octo/app.git"],
      "wrong",
    );
    expect(clone.ok).toBe(false);
  });
});

describe("REST 接口经过代理", () => {
  it("本会话仓库的接口放行，占位令牌换成用户的令牌", async () => {
    const res = await rest("GET", "/repos/octo/app/pulls");
    expect(res.status).toBe(200);
    expect(github.requests.at(-1)).toMatchObject({
      host: "api.github.com",
      path: "/repos/octo/app/pulls",
      authorization: `Bearer ${USER_TOKEN}`,
    });
  });

  it("用户在环境里自己设了令牌：原样转发，不替换", async () => {
    await rest("GET", "/repos/octo/app/issues", { auth: "token ghp_users_own" });
    expect(github.requests.at(-1)?.authorization).toBe("token ghp_users_own");
  });

  it("GraphQL、别的仓库、删分支、建标签、建 release：返回 403 并说明原因，请求没有发出去", async () => {
    const before = github.requests.length;
    const cases = [
      await rest("POST", "/graphql", { body: '{"query":"{viewer{login}}"}' }),
      await rest("GET", "/repos/other/secret/contents/README.md"),
      await rest("DELETE", "/repos/octo/app/git/refs/heads/main"),
      await rest("POST", "/repos/octo/app/git/refs", { body: '{"ref":"refs/tags/v1","sha":"x"}' }),
      await rest("POST", "/repos/octo/app/releases", { body: '{"tag_name":"v1"}' }),
    ];
    expect(cases.map((c) => c.status)).toEqual([403, 403, 403, 403, 403]);
    expect(cases[0]?.body).toContain("REST");
    expect(cases[1]?.body).toContain("没有挂载");
    expect(github.requests.length).toBe(before);
  });

  it("创建分支引用放行；转发的是检查过的那份（重复的键骗不过去）", async () => {
    const body = '{"ref":"refs/heads/feature","sha":"abc"}';
    const res = await rest("POST", "/repos/octo/app/git/refs", { body });
    expect(res.status).toBe(200);
    expect(github.requests.at(-1)?.body).toBe(body);
    const sneaky = await rest("POST", "/repos/octo/app/git/refs", {
      body: '{"ref":"refs/heads/x","sha":"abc","ref":"refs/tags/v1"}',
    });
    expect(sneaky.status).toBe(403);
  });

  it("地址里的编码不对：返回 400，代理照常工作（以前会让整个进程退出）", async () => {
    const bad = await rest("GET", "/repos/octo/app/contents/%E0%A4");
    expect(bad.status).toBe(400);
    expect((await rest("GET", "/repos/octo/app/pulls")).status).toBe(200);
  });

  it("连不上 GitHub：沙箱里只看到错误码，看不到上游的地址", async () => {
    // 先占一个端口再关掉，保证没人在听。
    const closed = http.createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const deadUpstream = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((done) => closed.close(() => done()));
    const broken = createGitProxy({
      sessions,
      ca,
      signingKey,
      signerEmail: BOT_EMAIL,
      upstreams: { "api.github.com": deadUpstream },
    });
    await new Promise<void>((done) => broken.listen(0, "127.0.0.1", done));
    try {
      const port = (broken.address() as AddressInfo).port;
      const res = await new Promise<{ status: number; body: string }>((done, fail) => {
        const req = http.request(`http://127.0.0.1:${port}`, {
          path: "http://api.github.com/repos/octo/app/pulls",
          headers: {
            "proxy-authorization": `Basic ${Buffer.from(`session:${SESSION_TOKEN}`).toString("base64")}`,
          },
        });
        req.on("response", (r) => {
          let body = "";
          r.on("data", (c: Buffer) => {
            body += c;
          });
          r.on("end", () => done({ status: r.statusCode ?? 0, body }));
        });
        req.on("error", fail);
        req.end();
      });
      expect(res.status).toBe(502);
      expect(res.body).toContain("连不上 GitHub（ECONNREFUSED）");
      expect(res.body).not.toContain(deadUpstream.replace("http://", ""));
    } finally {
      await new Promise<void>((done) => broken.close(() => done()));
    }
  });
});

describe("会话结束", () => {
  it("已经建好的 HTTPS 连接上，会话注销以后的请求也不放行", async () => {
    sessions.register({
      sessionId: "s2",
      sessionToken: "sess_short",
      repos: [{ fullName: "octo/app", access: "push" }],
    });
    sessions.setGitHubToken("s2", USER_TOKEN);
    const port = (proxy.address() as AddressInfo).port;
    const raw = net.connect(port, "127.0.0.1");
    await new Promise((done) => raw.once("connect", done));
    raw.write(
      `CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\nProxy-Authorization: Basic ${Buffer.from("session:sess_short").toString("base64")}\r\n\r\n`,
    );
    const established = await new Promise<string>((done) =>
      raw.once("data", (d) => done(String(d))),
    );
    expect(established).toContain("200");
    const secure = tls.connect({ socket: raw, servername: "api.github.com", ca: ca.certPem });
    await new Promise((done) => secure.once("secureConnect", done));

    const ask = () =>
      new Promise<number>((done) => {
        let buffer = "";
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString();
          const end = buffer.indexOf("\r\n\r\n");
          if (end === -1) return;
          const length = Number(/content-length: (\d+)/i.exec(buffer)?.[1] ?? 0);
          if (buffer.length < end + 4 + length) return;
          secure.off("data", onData);
          done(Number(buffer.split(" ")[1]));
        };
        secure.on("data", onData);
        secure.write(
          `GET /repos/octo/app/pulls HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token ${TOKEN_PLACEHOLDER}\r\nConnection: keep-alive\r\n\r\n`,
        );
      });

    expect(await ask()).toBe(200);
    sessions.remove("s2");
    expect(await ask()).toBe(403);
    secure.destroy();
  });
});

describe("提交签名", () => {
  it("沙箱里的 git 用签名助手签名，宿主机代签；git 能验证签名，签名密钥不在沙箱里", async () => {
    const dir = tmp();
    await sandboxGit(dir, ["clone", "-q", "http://github.com/octo/app.git", "app"]);
    const app = join(dir, "app");
    const allowed = join(dir, "allowed_signers");
    writeFileSync(allowed, `${BOT_EMAIL} ${signingKey.publicLine}\n`);
    const env = cleanGitEnv(mkdtempSync(join(tmpdir(), "home-")), {
      SEEKCLOUD_SESSION_TOKEN: SESSION_TOKEN,
      SEEKCLOUD_SIGN_URL: `${proxyUrl}/sign`,
      GIT_COMMITTER_EMAIL: BOT_EMAIL,
    });
    const config = [
      "-c",
      "gpg.format=ssh",
      "-c",
      `gpg.ssh.program=${SIGNER}`,
      "-c",
      `user.signingkey=key::${signingKey.publicLine}`,
      "-c",
      `gpg.ssh.allowedSignersFile=${allowed}`,
      "-c",
      `user.email=${BOT_EMAIL}`,
    ];
    const run = (args: string[], extra: Record<string, string> = {}) =>
      new Promise<{ ok: boolean; output: string }>((done) =>
        execFile(
          "git",
          [...config, ...args],
          { cwd: app, env: { ...env, ...extra } },
          (e, o, err) => done({ ok: !e, output: `${o}${err}` }),
        ),
      );
    const commit = await run(["commit", "-q", "-S", "--allow-empty", "-m", "签名的提交"]);
    expect(commit.output).toBe("");
    const verified = await run(["verify-commit", "-v", "HEAD"]);
    expect(verified.ok).toBe(true);
    expect(verified.output).toContain("Good");

    const refused = await run(["commit", "-q", "-S", "--allow-empty", "-m", "x"], {
      SEEKCLOUD_SESSION_TOKEN: "wrong",
    });
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("会话令牌不对");

    // 提交者不是 SeekCloud 账号（比如想冒充别人）：不签。
    const impostor = await run(["commit", "-q", "-S", "--allow-empty", "-m", "冒充"], {
      GIT_COMMITTER_EMAIL: "someone@example.com",
    });
    expect(impostor.ok).toBe(false);
    expect(impostor.output).toContain("只给提交者是 SeekCloud 账号");
  });

  it("签名服务只签 git 对象", async () => {
    const res = await fetch(`${proxyUrl}/sign?namespace=git`, {
      method: "POST",
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      body: "随便什么东西",
    });
    expect(res.status).toBe(400);
    const wrongNamespace = await fetch(`${proxyUrl}/sign?namespace=file`, {
      method: "POST",
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      body: `tree ${"a".repeat(40)}\n`,
    });
    expect(wrongNamespace.status).toBe(400);
  });
});
