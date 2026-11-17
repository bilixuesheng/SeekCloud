import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";

/** 一个迁移目录（drizzle-kit 生成的格式）和记它跑到哪一步的表。 */
export interface MigrationSet {
  folder: string;
  /** 记录表的名字，放在 drizzle 这个 schema 里。每个目录用自己的表，互不干扰。 */
  table: string;
}

/** 主干的迁移。记录表是 drizzle 的默认名字，已经部署的站点不会重跑。 */
export const TRUNK_MIGRATIONS: MigrationSet = {
  folder: fileURLToPath(new URL("./migrations", import.meta.url)),
  table: "__drizzle_migrations",
};

/**
 * 先跑主干的迁移，再按顺序跑下游的（ADR 0010：下游的表放自己的迁移目录）。主干只有一个目录。
 * 下游的记录表不能和主干或彼此重名，否则一个目录会把另一个的记录当成自己的。
 */
export async function runMigrations(db: Database, downstream: MigrationSet[] = []): Promise<void> {
  const tables = new Set<string>([TRUNK_MIGRATIONS.table]);
  for (const set of downstream) {
    if (tables.has(set.table)) throw new Error(`迁移的记录表重名：${set.table}`);
    tables.add(set.table);
  }
  for (const set of [TRUNK_MIGRATIONS, ...downstream]) {
    await migrate(db, { migrationsFolder: set.folder, migrationsTable: set.table });
  }
}
