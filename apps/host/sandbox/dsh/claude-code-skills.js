// SeekCloud 给 dsh 加的技能提供方（#17）：照 Claude Code 读仓库里的 .claude/skills 和 .claude/commands。
//
// dsh 自己只扫 .dsh/skills 和 .agents/skills，而且要求 SKILL.md 的 frontmatter 里 name、description 都写了；
// .claude/commands 下的单个 Markdown 文件它不认。这个插件补上这两样，规矩照 Claude Code：
//
// - .claude/skills/<名字>/SKILL.md：name 不写就用目录名，description 不写就用正文的第一段；
// - .claude/commands/<名字>.md（可以再分一层子目录）：文件名就是名字，和技能一样能被调用；
//   技能和命令同名时技能优先；
// - frontmatter 里 disable-model-invocation: true 的只能由人调用，user-invocable: false 的只能由模型调用；
// - 仓库根目录（往上找 .git）和用户目录（~/.claude）都读，同名时仓库里的优先。
//
// 装进通用镜像的 /usr/local/share/seekcloud/dsh/，由同目录的 baseline.patch.yml 插进 dsh。
// 不依赖 dsh 以外的包：frontmatter 只读 Claude Code 用得到的简单写法（单行的值、引号、| 和 > 的多行块、列表）。
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const name = "seekcloud-claude-code-skills";
export const inject = ["skills"];

const PROVIDER = "claude-code";
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 一个技能文件最多读这么多。 */
const MAX_FILE_BYTES = 256 * 1024;
/** 多久看一次文件有没有变（变了就让 dsh 重新列技能）。 */
const POLL_MS = 2000;
/**
 * 排序：数字小的同名时胜出。dsh 自己的是仓库里 .dsh/skills 100、.agents/skills 200，用户目录 400、500；
 * 这里的排在它们各自后面，同名时 dsh 原生的目录优先。
 */
const RANK = { projectSkill: 210, projectCommand: 220, userSkill: 510, userCommand: 520 };

/**
 * @param {{ skills: { registerProvider(create: (control: { signal: AbortSignal, invalidate(): void }) => unknown): unknown }, logger?: { warn?(message: string): void } }} ctx
 * @param {{ home?: string, pollMs?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const home = config.home ?? homedir();
  const warn = (message) => ctx.logger?.warn?.(`[${name}] ${message}`);
  ctx.skills.registerProvider((control) => {
    /** 列过的目录和当时的样子，变了就让 dsh 重新列。 */
    const seen = new Map();
    const timer = setInterval(async () => {
      for (const [dir, before] of seen) {
        const now = await signature(dir);
        if (now !== before) {
          seen.set(dir, now);
          control.invalidate();
        }
      }
    }, config.pollMs ?? POLL_MS);
    timer.unref?.();
    control.signal.addEventListener("abort", () => clearInterval(timer), { once: true });

    return {
      name: PROVIDER,
      async list(options = {}) {
        const roots = [];
        if (options.cwd !== undefined) {
          const project = await findProjectRoot(resolve(options.cwd));
          roots.push(
            {
              dir: join(project, ".claude", "skills"),
              kind: "skill",
              source: "project-claude",
              rank: RANK.projectSkill,
            },
            {
              dir: join(project, ".claude", "commands"),
              kind: "command",
              source: "project-claude",
              rank: RANK.projectCommand,
            },
          );
        }
        roots.push(
          {
            dir: join(home, ".claude", "skills"),
            kind: "skill",
            source: "user-claude",
            rank: RANK.userSkill,
          },
          {
            dir: join(home, ".claude", "commands"),
            kind: "command",
            source: "user-claude",
            rank: RANK.userCommand,
          },
        );
        const candidates = [];
        for (const root of roots) {
          seen.set(root.dir, await signature(root.dir));
          const files =
            root.kind === "skill" ? await skillFiles(root.dir) : await commandFiles(root.dir);
          const names = new Set();
          for (const file of files) {
            const parsed = await readSkill(file, root.kind, warn);
            // 同一个目录里重名（比如两个子目录里都有 review.md）：先找到的算
            if (!parsed || names.has(parsed.name)) continue;
            names.add(parsed.name);
            candidates.push({
              ...summary(parsed, root),
              rank: root.rank,
              locator: { file, kind: root.kind, root },
            });
          }
        }
        return candidates;
      },
      async get(candidate) {
        const { file, kind, root } = candidate.locator ?? {};
        if (typeof file !== "string") return undefined;
        const parsed = await readSkill(file, kind, warn);
        if (!parsed) return undefined;
        return { ...summary(parsed, root), content: parsed.content };
      },
    };
  });
}

/** dsh 要的技能信息（不含正文）。 */
function summary(parsed, root) {
  return {
    path: parsed.file,
    name: parsed.name,
    description: parsed.description,
    invocation: parsed.invocation,
    source: root.source,
    provider: PROVIDER,
    resourceBase: { kind: "directory", path: dirname(parsed.file) },
    metadata: parsed.metadata,
  };
}

/** 往上找 .git 所在的目录；找不到就用 cwd 本身（和 dsh 自己的规矩一样）。 */
async function findProjectRoot(cwd) {
  let current = cwd;
  for (;;) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

/** <目录>/<名字>/SKILL.md */
async function skillFiles(dir) {
  const files = [];
  for (const entry of await entries(dir)) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (await exists(file)) files.push(file);
  }
  return files;
}

/** <目录>/<名字>.md，再加一层子目录 <目录>/<分组>/<名字>.md。顶层的排在前面，重名时顶层的算。 */
async function commandFiles(dir) {
  const top = [];
  const nested = [];
  for (const entry of await entries(dir)) {
    if (entry.isFile() && entry.name.endsWith(".md")) top.push(join(dir, entry.name));
    else if (entry.isDirectory()) {
      for (const inner of await entries(join(dir, entry.name))) {
        if (inner.isFile() && inner.name.endsWith(".md"))
          nested.push(join(dir, entry.name, inner.name));
      }
    }
  }
  return [...top.sort(), ...nested.sort()];
}

/** 读一个技能或命令文件。名字不合规矩、读不了的跳过并记一条警告。 */
async function readSkill(file, kind, warn) {
  let text;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      warn(`${file} 不是文件或者太大（超过 ${MAX_FILE_BYTES} 字节），跳过`);
      return undefined;
    }
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const { data, body } = parseFrontmatter(text);
  const fallbackName = kind === "skill" ? basename(dirname(file)) : basename(file, ".md");
  const skillName = toSkillName(
    typeof data.name === "string" && data.name ? data.name : fallbackName,
  );
  if (!skillName) {
    warn(`${file} 的名字不能用作技能名（只能是小写字母、数字和连字符），跳过`);
    return undefined;
  }
  const description =
    (typeof data.description === "string" && data.description.trim()) ||
    firstParagraph(body) ||
    skillName;
  let content = body.trim();
  if (kind === "command" && /\$(ARGUMENTS|\d)/.test(content)) {
    content =
      "(This is a Claude Code command. `$ARGUMENTS` stands for the text the user typed after the command, and `$1`, `$2`, … for its whitespace-separated parts.)\n\n" +
      content;
  }
  return {
    file,
    name: skillName,
    description,
    content,
    invocation: {
      modelInvocable: data["disable-model-invocation"] !== true,
      userInvocable: data["user-invocable"] !== false,
    },
    metadata: data,
  };
}

/** Claude Code 的名字可以有大写、下划线、空格；dsh 只认小写加连字符。转不过来的返回 undefined。 */
function toSkillName(raw) {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return SKILL_NAME.test(normalized) ? normalized : undefined;
}

/** 正文的第一段（跳过标题），作为没写 description 时的说明。 */
function firstParagraph(body) {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const text = paragraphs.find((p) => !p.startsWith("#")) ?? paragraphs[0]?.replace(/^#+\s*/, "");
  return text?.replace(/\s+/g, " ").slice(0, 1024);
}

/**
 * 读 frontmatter：第一行是 ---，到下一个 --- 为止。支持 Claude Code 用得到的写法：
 * key: 值、带引号的值、true/false、| 和 > 开头的多行块、- 开头的列表。别的照字符串收。
 */
export function parseFrontmatter(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: {}, body: text };
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return { data: {}, body: text };
  const data = {};
  for (let i = 1; i < end; i++) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i] ?? "");
    if (!match) continue;
    const key = match[1];
    const value = (match[2] ?? "").trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < end && /^(\s+|$)/.test(lines[i + 1] ?? ""))
        block.push((lines[++i] ?? "").trim());
      data[key] = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
      continue;
    }
    if (value === "") {
      const items = [];
      while (i + 1 < end && /^\s*-\s+/.test(lines[i + 1] ?? ""))
        items.push(unquote((lines[++i] ?? "").replace(/^\s*-\s+/, "")));
      data[key] = items.length > 0 ? items : "";
      continue;
    }
    if (value === "true" || value === "false") data[key] = value === "true";
    else data[key] = unquote(value);
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

function unquote(value) {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 一个目录现在的样子：里面每个技能文件的路径和修改时间。 */
async function signature(dir) {
  const parts = [];
  for (const file of [...(await skillFiles(dir)), ...(await commandFiles(dir))]) {
    try {
      parts.push(`${file}:${(await stat(file)).mtimeMs}`);
    } catch {
      // 刚被删掉
    }
  }
  return parts.join("|");
}
