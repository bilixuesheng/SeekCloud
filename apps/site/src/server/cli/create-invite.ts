// 管理员在服务器上建邀请码：pnpm invite:create [--count 5] [--days 30]
// 管理端的界面在后面的工单里做；在那之前用这个命令。
import { parseArgs } from "node:util";
import { createInviteCode } from "../auth/invites";
import { connectDatabase } from "../db/client";
import { systemClock } from "../ports";

const { values } = parseArgs({
  options: { count: { type: "string", default: "1" }, days: { type: "string" } },
});
const count = Number(values.count);
const days = values.days === undefined ? undefined : Number(values.days);
if (!Number.isInteger(count) || count < 1 || (days !== undefined && !(days > 0))) {
  console.error("用法：pnpm invite:create [--count 数量] [--days 有效天数]");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("缺少环境变量 DATABASE_URL");
const { db, close } = connectDatabase(databaseUrl);

const now = systemClock.now();
const expiresAt = days === undefined ? undefined : new Date(now.getTime() + days * 86_400_000);
for (let i = 0; i < count; i++) {
  console.log(await createInviteCode({ db, clock: systemClock }, { expiresAt }));
}
console.log(expiresAt ? `有效期到 ${expiresAt.toISOString()}` : "不过期");
await close();
