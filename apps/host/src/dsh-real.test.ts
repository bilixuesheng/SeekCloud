import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeModelServer } from "./testing/fake-model-server";

/**
 * 用真的 dsh 跑一个回合（#17 的验收）：叠上 SeekCloud 的基线配置，模型服务是假的，看 dsh 发出去的请求。
 * 设 SEEKCLOUD_DSH_BIN 指向 dsh 的可执行文件才跑（要 Node 24.9 以上，CI 的 dsh 那一项装好了）。
 */
const DSH = process.env.SEEKCLOUD_DSH_BIN;
const BASELINE = join(import.meta.dirname, "../sandbox/dsh/baseline.patch.yml");

describe.skipIf(!DSH)("真的 dsh 叠上基线配置", { timeout: 120_000 }, () => {
  const model = new FakeModelServer();
  let root: string;
  let stdout = "";

  beforeAll(async () => {
    const url = await model.start();
    root = await mkdtemp(join(tmpdir(), "seekcloud-dsh-real-"));
    const repo = join(root, "repo");
    const files: Record<string, string> = {
      ".claude/skills/deploy-check/SKILL.md":
        "---\nname: deploy-check\ndescription: 发布前检查清单\n---\n先跑测试。\n",
      ".claude/commands/review.md":
        "---\ndescription: Review the current diff\n---\nReview $ARGUMENTS.\n",
      ".claude/commands/frontend/Make_Component.md": "Make a React component named $1.\n",
      ".claude/commands/release.md":
        "---\ndisable-model-invocation: true\n---\nOnly humans run this.\n",
      "packages/app/README.md": "",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
    await promisify(execFile)("git", ["init", "-q", repo]);
    const home = join(root, "home");
    await mkdir(home);
    ({ stdout } = await promisify(execFile)(
      DSH as string,
      ["--profile", "headless", "--patch", BASELINE, "你好"],
      {
        // 从仓库的子目录里启动：插件要自己往上找到仓库根
        cwd: join(repo, "packages/app"),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          DSH_HOME: join(home, ".dsh"),
          DEEPSEEK_API_KEY: "fake-key",
          DEEPSEEK_BASE_URL: url,
          // 遥测要是没关住，会往这里报：也指到假服务上，好看见
          OTEL_EXPORTER_OTLP_ENDPOINT: url,
        },
        timeout: 100_000,
      },
    ));
  });
  afterAll(async () => {
    await model.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("回合跑完，回复是假模型说的那句", () => {
    expect(stdout.trim()).toBe("好的");
    expect(model.messages().length).toBeGreaterThan(0);
  });

  it("请求里没有会话日志和插件清单，也没有往遥测地址报", () => {
    for (const body of model.messages()) {
      expect(Object.keys(body)).not.toContain("dsh_session_log");
      expect(Object.keys(body)).not.toContain("dsh_plugin_packages");
      expect(JSON.stringify(body)).not.toMatch(/dsh_session_log|dsh_plugin_packages/);
    }
    expect(model.requests.filter((r) => /\/v1\/(traces|metrics|logs)/.test(r.path))).toEqual([]);
  });

  it("模型看得到仓库里 .claude/skills 和 .claude/commands 的技能，只能由人调用的看不到", () => {
    const first = JSON.stringify(model.messages()[0]);
    expect(first).toContain("- `deploy-check`: 发布前检查清单");
    expect(first).toContain("- `review`: Review the current diff");
    expect(first).toContain("- `make-component`: Make a React component named $1.");
    expect(first).not.toMatch(/- `release`/);
  });
});

describe.skipIf(!DSH)("真的 dsh：逐字输出的插件", { timeout: 120_000 }, () => {
  it("有运行器给的文件描述符时，模型输出的增量和 token 数一行一行写出来", async () => {
    const model = new FakeModelServer();
    model.reply = "逐字的回复";
    const url = await model.start();
    const root = await mkdtemp(join(tmpdir(), "seekcloud-dsh-live-"));
    try {
      const child = spawn(DSH as string, ["--profile", "headless", "--patch", BASELINE, "你好"], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: root,
          DSH_HOME: join(root, ".dsh"),
          DEEPSEEK_API_KEY: "fake-key",
          DEEPSEEK_BASE_URL: url,
          SEEKCLOUD_LIVE_FD: "3",
        },
      });
      const live: unknown[] = [];
      createInterface({ input: child.stdio[3] as NodeJS.ReadableStream }).on("line", (line) =>
        live.push(JSON.parse(line)),
      );
      const code = await new Promise((resolve) => child.on("close", resolve));
      expect(code).toBe(0);
      expect(live).toContainEqual({ kind: "text", text: "逐字的回复" });
      expect(live.some((l) => typeof (l as { tokens?: unknown }).tokens === "number")).toBe(true);
      expect(
        live.every((l) => !("call" in (l as object)) || (l as { call: number }).call === 1),
      ).toBe(true);
    } finally {
      await model.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
