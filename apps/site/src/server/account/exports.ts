import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent } from "@seekcloud/protocol";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { strToU8, type Zippable, zipSync } from "fflate";
import type { AppDeps } from "../app";
import {
  dataExports,
  environments,
  identities,
  sessionEvents,
  sessionRepos,
  sessions,
  users,
} from "../db/schema";
import { AI_NOTICE, sessionJson, sessionMarkdown, utcTime } from "./transcript";

/**
 * 导出数据：
 * - 打包账户资料、全部会话（JSON 和 Markdown）、环境配置；
 * - 后台任务打包（runMaintenance 每分钟跑一次），好了发邮件，24 小时内可以下载；
 * - 每 24 小时只能申请一次，没打成的不算。
 */
export const EXPORT_TTL_MS = 24 * 60 * 60_000;
export const EXPORT_INTERVAL_MS = 24 * 60 * 60_000;
/** 打包到一半进程退出了：过了这么久还是"正在打包"，就当没开始，重新打。 */
const STALE_BUILD_MS = 15 * 60_000;

export type ExportRow = typeof dataExports.$inferSelect;

export const exportFile = (deps: Pick<AppDeps, "dataDir">, id: string) =>
  join(deps.dataDir, "exports", `${id}.zip`);

/** 下载时的文件名：seekcloud-export-2026-11-01.zip。 */
export const exportFileName = (row: Pick<ExportRow, "createdAt">) =>
  `seekcloud-export-${row.createdAt.toISOString().slice(0, 10)}.zip`;

/** 设置页上显示的导出状态：最近一次导出，以及什么时候可以再导出（null 表示现在就可以）。 */
export async function exportOverview(deps: AppDeps, userId: string, now = deps.clock.now()) {
  const [latest] = await deps.db
    .select()
    .from(dataExports)
    .where(eq(dataExports.userId, userId))
    .orderBy(desc(dataExports.createdAt))
    .limit(1);
  return { latest: latest ?? null, nextAvailableAt: await nextAvailableAt(deps.db, userId, now) };
}

type Db = Pick<AppDeps["db"], "select">;

/** 24 小时内申请过（没失败的）就要等到那次之后满 24 小时。 */
async function nextAvailableAt(db: Db, userId: string, now: Date): Promise<Date | null> {
  const [recent] = await db
    .select({ createdAt: dataExports.createdAt })
    .from(dataExports)
    .where(
      and(
        eq(dataExports.userId, userId),
        sql`${dataExports.status} <> 'failed'`,
        gt(dataExports.createdAt, new Date(now.getTime() - EXPORT_INTERVAL_MS)),
      ),
    )
    .orderBy(desc(dataExports.createdAt))
    .limit(1);
  return recent ? new Date(recent.createdAt.getTime() + EXPORT_INTERVAL_MS) : null;
}

/** 申请导出。锁住用户这一行，同时点两次也只建一个。 */
export async function requestExport(
  deps: AppDeps,
  userId: string,
): Promise<{ ok: true; row: ExportRow } | { ok: false; nextAvailableAt: Date }> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    const next = await nextAvailableAt(tx, userId, now);
    if (next) return { ok: false as const, nextAvailableAt: next };
    const [row] = await tx
      .insert(dataExports)
      .values({ userId, status: "pending", createdAt: now })
      .returning();
    return { ok: true as const, row: row as ExportRow };
  });
}

/** 打包所有等着的导出，返回打好了几个。 */
export async function buildPendingExports(deps: AppDeps): Promise<number> {
  let built = 0;
  for (;;) {
    const row = await claimNext(deps);
    if (!row) return built;
    try {
      await buildOne(deps, row);
      built += 1;
    } catch (error) {
      console.error("导出数据打包失败", row.id, error);
      await deps.db.update(dataExports).set({ status: "failed" }).where(eq(dataExports.id, row.id));
    }
  }
}

/** 领一个等着打包的导出。SKIP LOCKED：同时有两个任务在跑也不会领到同一个。 */
async function claimNext(deps: AppDeps): Promise<ExportRow | undefined> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(dataExports)
      .where(
        or(
          eq(dataExports.status, "pending"),
          and(
            eq(dataExports.status, "building"),
            lt(dataExports.startedAt, new Date(now.getTime() - STALE_BUILD_MS)),
          ),
        ),
      )
      .orderBy(asc(dataExports.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return undefined;
    const [claimed] = await tx
      .update(dataExports)
      .set({ status: "building", startedAt: now })
      .where(eq(dataExports.id, row.id))
      .returning();
    return claimed;
  });
}

async function buildOne(deps: AppDeps, row: ExportRow): Promise<void> {
  const [user] = await deps.db.select().from(users).where(eq(users.id, row.userId));
  // 申请以后删了账户：不打包，也不发信。
  if (!user || user.deletedAt) {
    await deps.db.update(dataExports).set({ status: "expired" }).where(eq(dataExports.id, row.id));
    return;
  }
  const zip = zipSync(await collectFiles(deps, user, deps.clock.now()), { level: 6 });
  const path = exportFile(deps, row.id);
  await mkdir(join(deps.dataDir, "exports"), { recursive: true });
  // 先写临时文件再改名：写到一半出错，不会留下一个打不开的压缩包给人下载。
  await writeFile(`${path}.tmp`, zip);
  await rename(`${path}.tmp`, path);

  const readyAt = deps.clock.now();
  const expiresAt = new Date(readyAt.getTime() + EXPORT_TTL_MS);
  await deps.db
    .update(dataExports)
    .set({ status: "ready", sizeBytes: zip.byteLength, readyAt, expiresAt })
    .where(eq(dataExports.id, row.id));

  // 发不出去也不要紧：设置页上照样能下载。
  await deps.mailer
    .send({
      to: user.email,
      subject: "SeekCloud：数据导出已完成",
      text: [
        `你申请的数据导出已打包完成，可在 ${utcTime(expiresAt)} 前下载：`,
        "",
        `${deps.publicUrl}/settings/privacy`,
        "",
        "请登录后在“设置 → 隐私”中点击“下载”。",
        "",
        "如非本人申请，请检查账户的登录方式，必要时在设置中选择“在所有设备上退出”。",
      ].join("\n"),
    })
    .catch((error: unknown) => console.error("导出完成的邮件没发出去", row.id, error));
}

type UserRow = typeof users.$inferSelect;

/** 压缩包里的文件。不放任何令牌、验证码、密钥原文。 */
async function collectFiles(deps: AppDeps, user: UserRow, now: Date): Promise<Zippable> {
  const { db } = deps;
  const json = (value: unknown) => strToU8(`${JSON.stringify(value, null, 2)}\n`);

  const linked = await db
    .select({
      provider: identities.provider,
      login: identities.login,
      createdAt: identities.createdAt,
    })
    .from(identities)
    .where(eq(identities.userId, user.id))
    .orderBy(asc(identities.provider));
  const envs = await db
    .select({
      name: environments.name,
      networkAccess: environments.networkAccess,
      isDefault: environments.isDefault,
      createdAt: environments.createdAt,
    })
    .from(environments)
    .where(eq(environments.userId, user.id))
    .orderBy(asc(environments.createdAt));
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, user.id))
    .orderBy(asc(sessions.createdAt));

  const files: Zippable = {
    "README.txt": strToU8(readme(user.email, now)),
    "account.json": json({
      email: user.email,
      createdAt: user.createdAt,
      termsVersion: user.termsVersion,
      termsAcceptedAt: user.termsAcceptedAt,
      identities: linked,
    }),
    // 环境变量和网络密钥做出来以后，在这里打码导出（只留名字，值换成 ***）。
    "environments.json": json(envs),
  };

  const ids = sessionRows.map((s) => s.id);
  const repos = ids.length
    ? await db
        .select()
        .from(sessionRepos)
        .where(inArray(sessionRepos.sessionId, ids))
        .orderBy(asc(sessionRepos.position))
    : [];
  const sessionsDir: Zippable = {};
  for (const session of sessionRows) {
    const eventRows = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, session.id))
      .orderBy(asc(sessionEvents.seq));
    const events = eventRows.map(
      (e) =>
        ({ seq: e.seq, at: e.createdAt.toISOString(), turn: e.turn, ...e.body }) as SessionEvent,
    );
    const meta = {
      shortId: session.shortId,
      title: session.title,
      status: session.status,
      model: session.model,
      effort: session.effort,
      createdAt: session.createdAt,
      repos: repos
        .filter((r) => r.sessionId === session.id)
        .map((r) => ({
          fullName: r.fullName,
          baseBranch: r.baseBranch,
          branch: r.branch,
          access: r.access,
        })),
    };
    // 文件名用短 ID：标题可能重复，也可能有文件名里不能用的字符。
    sessionsDir[`${session.shortId}.json`] = json(sessionJson(meta, events));
    sessionsDir[`${session.shortId}.md`] = strToU8(sessionMarkdown(meta, events));
  }
  if (sessionRows.length > 0) files.sessions = sessionsDir;
  return files;
}

function readme(email: string, now: Date): string {
  return [
    "SeekCloud · 数据导出",
    "",
    `账户：${email}`,
    `导出时间：${utcTime(now)}`,
    "",
    "account.json        账户资料：邮箱、注册时间、已同意的协议版本、已绑定的 GitHub 账号",
    "environments.json   环境配置",
    "sessions/*.json     各会话的完整记录（机器可读），文件名为会话短 ID",
    "sessions/*.md       各会话的可读版本",
    "",
    AI_NOTICE,
    "",
    "不包含：GitHub 令牌、登录验证码等凭据；代码保存在 GitHub，不在此导出中。",
    "",
  ].join("\n");
}

/** 过期的导出删掉文件。 */
export async function expireExports(deps: AppDeps): Promise<void> {
  const expired = await deps.db
    .update(dataExports)
    .set({ status: "expired" })
    .where(and(eq(dataExports.status, "ready"), lt(dataExports.expiresAt, deps.clock.now())))
    .returning({ id: dataExports.id });
  for (const { id } of expired) await rm(exportFile(deps, id), { force: true });
}

/** 能下载的导出：本人的、打好了的、没过期的、文件还在的。 */
export async function downloadableExport(deps: AppDeps, userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  const [row] = await deps.db
    .select()
    .from(dataExports)
    .where(
      and(
        eq(dataExports.id, id),
        eq(dataExports.userId, userId),
        eq(dataExports.status, "ready"),
        gt(dataExports.expiresAt, deps.clock.now()),
      ),
    );
  if (!row) return undefined;
  const path = exportFile(deps, row.id);
  const size = await stat(path).then(
    (s) => s.size,
    () => undefined,
  );
  return size === undefined ? undefined : { path, size, fileName: exportFileName(row) };
}
