import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase } from "../../testing/database";
import { connectDatabase } from "./client";

let database: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(() => database.drop());

it("空闲连接被数据库断开（比如数据库重启）：主站进程不崩溃，下一次查询换一条新连接", async () => {
  const { db, close } = connectDatabase(database.url);
  try {
    const before = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    const pid = before.rows[0]?.pid;

    // 从另一条连接把它踢掉，和数据库重启、主从切换时一样。
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    await admin.query("select pg_terminate_backend($1)", [pid]);
    await admin.end();
    // 等连接池收到断开的消息。没有 error 监听时，这里会变成未处理的异常，整个进程退出。
    await new Promise((resolve) => setTimeout(resolve, 100));

    const after = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    expect(after.rows[0]?.pid).not.toBe(pid);
  } finally {
    await close();
  }
});
