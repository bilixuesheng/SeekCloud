// 添加、吊销沙箱宿主机（部署向导做好以后改成在网页上做，#97）：
//   pnpm host:create <名字>   生成宿主机密钥并打印一次，填进宿主机的 SEEKCLOUD_HOST_KEY
//   pnpm host:revoke <名字>   吊销：这把密钥连不上了，已有的连接在几秒内断开
import { connectDatabase } from "../db/client";
import { createHost, HOST_NAME, revokeHost } from "../hosts/keys";

const [command, name] = process.argv.slice(2);
if ((command !== "create" && command !== "revoke") || !name) {
  console.error("用法：pnpm host:create <名字> 或 pnpm host:revoke <名字>");
  process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("缺少环境变量 DATABASE_URL");
const { db, close } = connectDatabase(databaseUrl);

try {
  if (command === "create") {
    const result = await createHost(db, name, new Date());
    if (!result.ok) {
      console.error(
        result.error === "invalid_name"
          ? `名字不符合要求：只能用小写字母、数字和连字符，最长 40 个字（${HOST_NAME}）。`
          : `已有名为 ${name} 的宿主机。`,
      );
      process.exitCode = 1;
    } else {
      console.log(`已添加宿主机 ${name}。宿主机密钥（只显示这一次，请妥善保存）：`);
      console.log(result.key);
      console.log("在宿主机上把它设为环境变量 SEEKCLOUD_HOST_KEY，再启动宿主机守护进程。");
    }
  } else if (await revokeHost(db, name, new Date())) {
    console.log(`已吊销宿主机 ${name}。它已有的连接会在几秒内断开。`);
  } else {
    console.error(`没有名为 ${name} 的宿主机，或者它已经被吊销。`);
    process.exitCode = 1;
  }
} finally {
  await close();
}
