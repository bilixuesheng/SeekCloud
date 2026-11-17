import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../testing/database";
import { connectDatabase } from "./client";
import { runMigrations, TRUNK_MIGRATIONS } from "./migrate";

/** 写一个 drizzle-kit 格式的迁移目录：meta/_journal.json 加每一步的 SQL。 */
async function migrationFolder(steps: { tag: string; sql: string }[]): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "seekcloud-migrations-"));
  await mkdir(join(folder, "meta"));
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: steps.map((step, idx) => ({
        idx,
        version: "7",
        when: 1_800_000_000_000 + idx,
        tag: step.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const step of steps) await writeFile(join(folder, `${step.tag}.sql`), step.sql);
  return folder;
}

describe("迁移执行器", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let connection: ReturnType<typeof connectDatabase>;
  const folders: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    connection = connectDatabase(database.url);
  });
  afterAll(async () => {
    await connection.close();
    await database.drop();
    await Promise.all(folders.map((f) => rm(f, { recursive: true, force: true })));
  });

  const count = async (table: string) => {
    const result = await connection.db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier("drizzle")}.${sql.identifier(table)}`,
    );
    return result.rows[0]?.n;
  };

  it("下游的目录在主干之后跑，用自己的记录表；再跑一次什么都不做", async () => {
    const folder = await migrationFolder([
      { tag: "0000_notes", sql: "CREATE TABLE downstream_notes (id serial PRIMARY KEY);" },
      { tag: "0001_note_text", sql: "ALTER TABLE downstream_notes ADD COLUMN body text;" },
    ]);
    folders.push(folder);
    const trunkSteps = await count(TRUNK_MIGRATIONS.table);
    const downstream = { folder, table: "__downstream_migrations" };

    await runMigrations(connection.db, [downstream]);
    await runMigrations(connection.db, [downstream]);

    expect(await count(TRUNK_MIGRATIONS.table)).toBe(trunkSteps);
    expect(await count("__downstream_migrations")).toBe(2);
    await connection.db.execute(sql`insert into downstream_notes (body) values ('ok')`);
  });

  it("几个下游目录各用各的记录表", async () => {
    const first = await migrationFolder([
      { tag: "0000_a", sql: "CREATE TABLE downstream_a (id serial PRIMARY KEY);" },
    ]);
    const second = await migrationFolder([
      { tag: "0000_b", sql: "CREATE TABLE downstream_b (id serial PRIMARY KEY);" },
    ]);
    folders.push(first, second);

    await runMigrations(connection.db, [
      { folder: first, table: "__a_migrations" },
      { folder: second, table: "__b_migrations" },
    ]);

    expect(await count("__a_migrations")).toBe(1);
    expect(await count("__b_migrations")).toBe(1);
  });

  it("记录表和主干或别的目录重名时不跑", async () => {
    const folder = await migrationFolder([
      { tag: "0000_c", sql: "CREATE TABLE downstream_c (id serial PRIMARY KEY);" },
    ]);
    folders.push(folder);

    await expect(
      runMigrations(connection.db, [{ folder, table: TRUNK_MIGRATIONS.table }]),
    ).rejects.toThrow("重名");
    await expect(
      runMigrations(connection.db, [
        { folder, table: "__c_migrations" },
        { folder, table: "__c_migrations" },
      ]),
    ).rejects.toThrow("重名");
    const tables = await connection.db.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_name = 'downstream_c'`,
    );
    expect(tables.rows[0]?.n).toBe(0);
  });
});
