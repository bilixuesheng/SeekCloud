import { describe, expect, it } from "vitest";
import { checkCreateRef, checkRequest, type MountedRepo, pushRefusals } from "./rules";

const repos: MountedRepo[] = [
  { fullName: "octo/app", access: "push" },
  { fullName: "someone/lib", access: "read" },
];

const check = (host: string, method: string, url: string) => {
  const u = new URL(`https://${host}${url}`);
  return checkRequest(repos, { host, method, path: u.pathname, query: u.searchParams });
};
const allowed = (d: ReturnType<typeof check>) => d.allow;

describe("Git 代理放行哪些请求", () => {
  it.each([
    ["github.com", "GET", "/octo/app.git/info/refs?service=git-upload-pack", true],
    ["github.com", "POST", "/octo/app.git/git-upload-pack", true],
    ["github.com", "GET", "/Octo/App/info/refs?service=git-receive-pack", true],
    ["github.com", "POST", "/octo/app.git/git-receive-pack", true],
    ["github.com", "GET", "/someone/lib.git/info/refs?service=git-upload-pack", true],
    ["github.com", "GET", "/someone/lib.git/info/refs?service=git-receive-pack", false],
    ["github.com", "GET", "/other/repo.git/info/refs?service=git-upload-pack", false],
    ["github.com", "GET", "/torvalds/linux/archive/refs/heads/master.zip", false],
    ["github.com", "GET", "/octo/app/archive/refs/heads/main.zip", true],
    ["github.com", "GET", "/login", false],
    ["codeload.github.com", "GET", "/octo/app/zip/refs/heads/main", true],
    ["codeload.github.com", "GET", "/torvalds/linux/zip/refs/heads/master", false],
    ["raw.githubusercontent.com", "GET", "/octo/app/main/README.md", true],
  ])("%s %s %s → %s", (host, method, url, expected) => {
    expect(allowed(check(host, method, url))).toBe(expected);
  });

  it.each([
    ["GET", "/repos/octo/app/pulls", true],
    ["POST", "/repos/octo/app/pulls", true],
    ["POST", "/repos/octo/app/issues/1/comments", true],
    ["GET", "/repos/someone/lib/pulls", true],
    ["POST", "/repos/someone/lib/issues", false],
    ["GET", "/repos/other/repo", false],
    ["POST", "/graphql", false],
    ["GET", "/user", true],
    ["GET", "/rate_limit", true],
    ["GET", "/search/repositories", false],
    ["GET", "/user/repos", false],
    ["DELETE", "/repos/octo/app/git/refs/heads/feature", false],
    ["PATCH", "/repos/octo/app/git/refs/heads/feature", true],
    ["PATCH", "/repos/octo/app/git/refs/tags/v1", false],
    ["POST", "/repos/octo/app/git/tags", false],
    ["POST", "/repos/octo/app/releases", false],
    ["GET", "/repos/octo/app/releases", true],
    ["POST", "/repos/octo/app/branches/main/rename", false],
    ["DELETE", "/repos/octo/app", false],
    ["PATCH", "/repos/octo/app", false],
    ["PUT", "/repos/octo/app/pulls/1/merge", true],
    ["PUT", "/repos/octo/app/contents/README.md", true],
    ["POST", "/repos/octo/app/statuses/abc", true],
    ["POST", "/repos/octo/app/commits/abc/comments", true],
    ["POST", "/repos/octo/app/git/blobs", true],
    ["POST", "/repos/octo/app/git/commits", true],
    ["POST", "/repos/octo/app/actions/runs/1/rerun", true],
    ["POST", "/repos/octo/app/actions/runs/1/cancel", true],
    ["DELETE", "/repos/octo/app/actions/runs/1/logs", false],
    ["POST", "/repos/octo/app/actions/workflows/ci.yml/dispatches", false],
    ["PUT", "/repos/octo/app/actions/secrets/X", false],
    ["POST", "/repos/octo/app/hooks", false],
    ["POST", "/repos/octo/app/keys", false],
    ["PUT", "/repos/octo/app/collaborators/evil", false],
    ["POST", "/repos/octo/app/transfer", false],
    ["DELETE", "/repos/octo/app/branches/main/protection", false],
    ["POST", "/repos/octo/app/forks", false],
    ["POST", "/repos/octo/app/dispatches", false],
    ["GET", "/repos/octo/app/keys", true],
  ])("api.github.com %s %s → %s", (method, url, expected) => {
    expect(allowed(check("api.github.com", method, url))).toBe(expected);
  });

  it.each([
    "//octo/app.git/info/refs",
    "/octo%2Fapp/info/refs",
    "/octo/app%5c..%5cother/info/refs",
  ])("奇怪的路径不放行：%s", (path) => {
    expect(allowed(check("github.com", "GET", `${path}?service=git-upload-pack`))).toBe(false);
  });

  it.each([
    "/repos/octo/app/contents/../../other/secret/contents/a",
    "/repos/octo/app/contents/%2e%2e/%2E%2E/other/secret",
    "/repos/octo/app/./pulls",
  ])("带 . 或 .. 的路径段不放行（归一化以后会变成别的仓库）：%s", (path) => {
    // 直接传原样的路径：GitHub 工具服务就是这样调用的，发请求时 fetch 才会把 .. 归一化掉。
    const raw = checkRequest(repos, {
      host: "api.github.com",
      method: "GET",
      path,
      query: new URLSearchParams(),
    });
    expect(raw).toMatchObject({ allow: false, status: 400 });
  });

  it("编码不对的地址返回 400，不会抛错", () => {
    const bad = checkRequest(repos, {
      host: "api.github.com",
      method: "GET",
      path: "/repos/octo/app/contents/%E0%A4",
      query: new URLSearchParams(),
    });
    expect(bad).toMatchObject({ allow: false, status: 400 });
    expect(allowed(check("api.github.com", "GET", "/repos/oc%74o/app"))).toBe(false);
  });

  it("拒绝时说明原因", () => {
    const graphql = check("api.github.com", "POST", "/graphql");
    expect(graphql).toMatchObject({ allow: false, status: 403 });
    expect(graphql.allow === false && graphql.message).toContain("REST");
    const other = check("github.com", "GET", "/other/repo.git/info/refs?service=git-upload-pack");
    expect(other.allow === false && other.message).toContain("没有挂载");
  });

  it("创建引用时，建标签不放行，建分支放行", () => {
    expect(checkCreateRef('{"ref":"refs/tags/v1","sha":"abc"}').allow).toBe(false);
    expect(checkCreateRef('{"ref":"refs/heads/x","sha":"abc"}').allow).toBe(true);
    expect(checkCreateRef("not json").allow).toBe(false);
  });

  it("推送：删分支、推标签、推分支以外的引用不放行；推送和强推分支放行", () => {
    const A = "a".repeat(40);
    const ZERO = "0".repeat(40);
    const reasons = pushRefusals([
      { oldSha: A, newSha: A, ref: "refs/heads/main" },
      { oldSha: A, newSha: ZERO, ref: "refs/heads/old" },
      { oldSha: ZERO, newSha: A, ref: "refs/tags/v1" },
      { oldSha: ZERO, newSha: A, ref: "refs/notes/commits" },
    ]);
    expect([...reasons.keys()]).toEqual(["refs/heads/old", "refs/tags/v1", "refs/notes/commits"]);
  });
});
