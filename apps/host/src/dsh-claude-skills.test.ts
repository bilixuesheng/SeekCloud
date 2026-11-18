import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * SeekCloud 给 dsh 加的技能提供方（apps/host/sandbox/dsh/claude-code-skills.js，#17）：
 * 照 Claude Code 读 .claude/skills 和 .claude/commands。这里用一个假的 dsh 上下文测它自己的规矩；
 * 装进真的 dsh 以后模型看得到哪些技能，在 dsh-real.test.ts 里测。
 */
interface Candidate {
  name: string;
  description: string;
  path: string;
  source: string;
  rank: number;
  invocation: { modelInvocable: boolean; userInvocable: boolean };
  locator: unknown;
}
interface Provider {
  name: string;
  list(options: { cwd?: string }): Promise<Candidate[]>;
  get(candidate: Candidate): Promise<(Candidate & { content: string }) | undefined>;
}
interface PluginModule {
  name: string;
  inject: string[];
  apply(
    ctx: {
      skills: { registerProvider(create: (control: Control) => Provider): () => void };
      logger: { warn(message: string): void };
    },
    config: { home: string; pollMs?: number },
  ): void;
  parseFrontmatter(text: string): { data: Record<string, unknown>; body: string };
}
interface Control {
  signal: AbortSignal;
  invalidate(): void;
}

const PLUGIN = join(import.meta.dirname, "../sandbox/dsh/claude-code-skills.js");

describe("Claude Code 的技能和命令（dsh 插件）", () => {
  let plugin: PluginModule;
  const cleanup: (() => Promise<void> | void)[] = [];
  beforeAll(async () => {
    plugin = (await import(pathToFileURL(PLUGIN).href)) as PluginModule;
  });
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  /** 一个临时目录，里面按 { 相对路径: 内容 } 建好文件。 */
  const fixture = async (files: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), "seekcloud-skills-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return root;
  };

  /** 像 dsh 那样装上插件，拿到它注册的提供方。 */
  const load = (home: string, pollMs?: number) => {
    const abort = new AbortController();
    cleanup.push(() => abort.abort());
    let provider: Provider | undefined;
    let invalidations = 0;
    const warnings: string[] = [];
    plugin.apply(
      {
        skills: {
          registerProvider: (create) => {
            provider = create({ signal: abort.signal, invalidate: () => invalidations++ });
            return () => {};
          },
        },
        logger: { warn: (m) => warnings.push(m) },
      },
      { home, pollMs },
    );
    if (!provider) throw new Error("插件没有注册提供方");
    return { provider, warnings, invalidations: () => invalidations, stop: () => abort.abort() };
  };

  const byName = (list: Candidate[]) => Object.fromEntries(list.map((c) => [c.name, c]));

  it("仓库里的 .claude/skills 和 .claude/commands 都是技能；从子目录里也往上找到仓库根", async () => {
    const repo = await fixture({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".claude/skills/deploy-check/SKILL.md":
        "---\nname: deploy-check\ndescription: 发布前检查清单\n---\n先跑测试。\n",
      ".claude/commands/review.md": "---\ndescription: Review the current diff\n---\nReview it.\n",
      ".claude/commands/frontend/Make_Component.md": "Make a React component named $1.\n",
      ".claude/commands/release.md":
        "---\ndisable-model-invocation: true\n---\nOnly humans run this.\n",
      "packages/app/src/index.ts": "",
    });
    const { provider } = load(await fixture({}));
    expect(provider.name).toBe("claude-code");
    expect(plugin.name).toBe("seekcloud-claude-code-skills");
    expect(plugin.inject).toEqual(["skills"]);

    const skills = byName(await provider.list({ cwd: join(repo, "packages/app/src") }));
    expect(Object.keys(skills).sort()).toEqual([
      "deploy-check",
      "make-component",
      "release",
      "review",
    ]);
    expect(skills["deploy-check"]).toMatchObject({
      description: "发布前检查清单",
      source: "project-claude",
      path: join(repo, ".claude/skills/deploy-check/SKILL.md"),
      invocation: { modelInvocable: true, userInvocable: true },
    });
    expect(skills.review?.description).toBe("Review the current diff");
    // 没写 description：用正文第一段
    expect(skills["make-component"]?.description).toBe("Make a React component named $1.");
    // 只能由人调用
    expect(skills.release?.invocation).toEqual({ modelInvocable: false, userInvocable: true });
    // 同名时 dsh 原生的目录优先（.dsh/skills 100、.agents/skills 200），技能优先于命令
    expect(skills["deploy-check"]?.rank).toBeGreaterThan(200);
    expect(skills["deploy-check"]?.rank).toBeLessThan(skills.review?.rank ?? 0);
  });

  it("name、description 不写时照 Claude Code：用目录名和正文第一段（跳过标题）", async () => {
    const repo = await fixture({
      ".git/HEAD": "",
      ".claude/skills/pdf-tools/SKILL.md":
        "# PDF 工具\n\n用来拆分、合并 PDF。\n第二行也算在第一段里。\n\n## 用法\n",
      ".claude/skills/blank/SKILL.md": "",
    });
    const skills = byName(await load(await fixture({})).provider.list({ cwd: repo }));
    expect(skills["pdf-tools"]?.description).toBe("用来拆分、合并 PDF。 第二行也算在第一段里。");
    // 什么都没写：说明就是名字
    expect(skills.blank?.description).toBe("blank");
  });

  it("读全文：去掉 frontmatter；命令里有 $ARGUMENTS 时前面加一句说明；文件没了就读不到", async () => {
    const repo = await fixture({
      ".git/HEAD": "",
      ".claude/commands/fix-issue.md":
        "---\ndescription: 修一个 issue\nargument-hint: [编号]\n---\n修 issue #$ARGUMENTS。\n",
      ".claude/skills/plain/SKILL.md":
        "---\ndescription: 普通技能\n---\n正文里的 $ARGUMENTS 不管。\n",
    });
    const { provider } = load(await fixture({}));
    const skills = byName(await provider.list({ cwd: repo }));
    const command = await provider.get(skills["fix-issue"] as Candidate);
    expect(command?.content).toMatch(/^\(This is a Claude Code command\. `\$ARGUMENTS` stands for/);
    expect(command?.content).toContain("修 issue #$ARGUMENTS。");
    expect(command?.content).not.toContain("argument-hint");
    expect((await provider.get(skills.plain as Candidate))?.content).toBe(
      "正文里的 $ARGUMENTS 不管。",
    );

    await rm(join(repo, ".claude/commands/fix-issue.md"));
    expect(await provider.get(skills["fix-issue"] as Candidate)).toBeUndefined();
  });

  it("名字转成小写加连字符；转不过来的跳过并记警告；同一个目录里重名的顶层优先", async () => {
    const repo = await fixture({
      ".git/HEAD": "",
      ".claude/commands/Run Tests.md": "跑测试",
      ".claude/commands/deploy.md": "顶层的 deploy",
      ".claude/commands/ops/deploy.md": "子目录里的 deploy",
      ".claude/commands/中文.md": "名字转不过来",
      ".claude/skills/Bad_Name/SKILL.md": "---\nname: 好名字\n---\n",
    });
    const { provider, warnings } = load(await fixture({}));
    const skills = byName(await provider.list({ cwd: repo }));
    expect(Object.keys(skills).sort()).toEqual(["deploy", "run-tests"]);
    expect(skills.deploy?.description).toBe("顶层的 deploy");
    expect(warnings.filter((w) => w.includes("不能用作技能名"))).toHaveLength(2);
  });

  it("用户目录的 ~/.claude 也读，排在仓库的后面；不在任何仓库里时只读用户目录", async () => {
    const home = await fixture({
      ".claude/skills/my-style/SKILL.md": "---\ndescription: 我的写法\n---\n",
      ".claude/commands/standup.md": "写站会总结",
    });
    const repo = await fixture({
      ".git/HEAD": "",
      ".claude/skills/my-style/SKILL.md": "仓库里的同名技能",
    });
    const { provider } = load(home);
    const all = await provider.list({ cwd: repo });
    const mine = all.filter((c) => c.name === "my-style");
    expect(mine.map((c) => c.source)).toEqual(["project-claude", "user-claude"]);
    expect(mine[0]?.rank).toBeLessThan(mine[1]?.rank ?? 0);
    expect((await provider.list({})).map((c) => c.name).sort()).toEqual(["my-style", "standup"]);
  });

  it("user-invocable: false 的只给模型用", async () => {
    const repo = await fixture({
      ".git/HEAD": "",
      ".claude/skills/background/SKILL.md":
        "---\ndescription: 背景知识\nuser-invocable: false\n---\n",
    });
    const [skill] = await load(await fixture({})).provider.list({ cwd: repo });
    expect(skill?.invocation).toEqual({ modelInvocable: true, userInvocable: false });
  });

  it("文件变了就让 dsh 重新列技能；停掉以后不再看", async () => {
    const repo = await fixture({ ".git/HEAD": "", ".claude/commands/a.md": "A" });
    const { provider, invalidations, stop } = load(await fixture({}), 20);
    await provider.list({ cwd: repo });
    await new Promise((r) => setTimeout(r, 80));
    expect(invalidations()).toBe(0);

    await writeFile(join(repo, ".claude/commands/b.md"), "B");
    await expect.poll(invalidations).toBe(1);
    // 改了内容（修改时间变了）也算
    const later = new Date(Date.now() + 5000);
    await utimes(join(repo, ".claude/commands/a.md"), later, later);
    await expect.poll(invalidations).toBe(2);

    stop();
    await writeFile(join(repo, ".claude/commands/c.md"), "C");
    await new Promise((r) => setTimeout(r, 100));
    expect(invalidations()).toBe(2);
  });

  it("frontmatter：引号、true/false、| 和 > 的多行块、列表；没有或者没收尾的当作没有", () => {
    const { data, body } = plugin.parseFrontmatter(
      [
        "---",
        'name: "quoted-name"',
        "description: >",
        "  折叠的",
        "  多行说明",
        "notes: |",
        "  第一行",
        "  第二行",
        "allowed-tools:",
        "  - Bash(git:*)",
        "  - 'Read'",
        "disable-model-invocation: true",
        "model: deepseek-chat",
        "---",
        "正文",
      ].join("\n"),
    );
    expect(data).toEqual({
      name: "quoted-name",
      description: "折叠的 多行说明",
      notes: "第一行\n第二行",
      "allowed-tools": ["Bash(git:*)", "Read"],
      "disable-model-invocation": true,
      model: "deepseek-chat",
    });
    expect(body).toBe("正文");
    expect(plugin.parseFrontmatter("没有 frontmatter")).toEqual({
      data: {},
      body: "没有 frontmatter",
    });
    expect(plugin.parseFrontmatter("---\nname: x\n没收尾").data).toEqual({});
  });
});
