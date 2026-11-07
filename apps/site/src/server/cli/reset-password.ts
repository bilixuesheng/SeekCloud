// 忘记管理员密码时在服务器上运行：pnpm admin:reset-password
// 换成一个随机密码并打印出来，所有设备上的登录状态作废。
import { resetAdminPassword } from "../auth/admin";
import { connectDatabase } from "../db/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("缺少环境变量 DATABASE_URL");
const { db, close } = connectDatabase(databaseUrl);

const password = await resetAdminPassword(db);
await close();
if (!password) {
  console.error("尚未设置管理员密码：打开网页即可设置。");
  process.exit(1);
}
console.log(`管理员密码已重置为：${password}`);
console.log("所有设备已退出登录。请用新密码登录，并在“设置 → 账户”中修改密码。");
