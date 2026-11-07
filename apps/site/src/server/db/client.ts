import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

export type Database = NodePgDatabase;

/** 事务里的数据库句柄。 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function connectDatabase(url: string): { db: Database; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: url });
  // 空闲的连接被数据库断开时（数据库重启、主从切换、删库），连接池会发出 error 事件。
  // 没人监听的话，Node 会把它当成未处理的异常，整个进程退出。连接池已经把这条连接扔掉了，
  // 下一次查询会建新连接，所以这里只记一笔。
  pool.on("error", (error) => {
    console.error(`数据库的一条空闲连接断开了：${error.message}`);
  });
  return { db: drizzle(pool), close: () => pool.end() };
}
