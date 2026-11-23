import { asc, eq } from "drizzle-orm";
import type { Database, Tx } from "./db/client";
import { environments } from "./db/schema";

/**
 * 首次设置管理员密码时自动建的环境：默认清单，没有变量，也没有安装脚本。
 * 名字存空的：界面按语言显示"默认环境"（#136：服务端不存现成的中文句子）；以后管理员改了名字就存改的。
 */
export function createDefaultEnvironment(tx: Tx, userId: string, now: Date) {
  return tx.insert(environments).values({
    userId,
    name: "",
    networkAccess: "default",
    isDefault: true,
    createdAt: now,
  });
}

export function listEnvironments(db: Database, userId: string) {
  return db
    .select({
      id: environments.id,
      name: environments.name,
      networkAccess: environments.networkAccess,
      isDefault: environments.isDefault,
    })
    .from(environments)
    .where(eq(environments.userId, userId))
    .orderBy(asc(environments.createdAt));
}
