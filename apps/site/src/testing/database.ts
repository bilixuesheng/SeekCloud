import { randomUUID } from "node:crypto";
import pg from "pg";
import { connectDatabase } from "../server/db/client";
import { runMigrations } from "../server/db/migrate";

// 建库、删库时连的 PostgreSQL 维护库。CI 和本地都用同一个默认值。
const maintenanceUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

// 全局准备时迁移一次，之后每个测试文件从它复制一个新库，比每次重跑迁移快。
const TEMPLATE = "seekcloud_test_template";

export function databaseUrlFor(name: string): string {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function runOnMaintenanceDatabase(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: maintenanceUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

function dropDatabase(name: string): Promise<void> {
  return runOnMaintenanceDatabase(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

export async function createTemplateDatabase(): Promise<void> {
  await dropTemplateDatabase();
  await runOnMaintenanceDatabase(`CREATE DATABASE ${TEMPLATE}`);
  const { db, close } = connectDatabase(databaseUrlFor(TEMPLATE));
  try {
    await runMigrations(db);
  } finally {
    await close();
  }
}

export function dropTemplateDatabase(): Promise<void> {
  return dropDatabase(TEMPLATE);
}

export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `seekcloud_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await runOnMaintenanceDatabase(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
  return { url: databaseUrlFor(name), drop: () => dropDatabase(name) };
}
