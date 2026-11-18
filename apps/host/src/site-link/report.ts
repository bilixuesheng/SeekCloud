import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { HostReport } from "@seekcloud/protocol";

/** 宿主机现在的负载，定时报给主站（给运行状况看）。磁盘看守护进程的数据目录所在的那块。 */
export function hostReport(dataDir: string, sandboxes: number): HostReport {
  let diskAvailable = 0;
  let diskTotal = 0;
  for (const path of [dataDir, "/"]) {
    try {
      const fs = statfsSync(path);
      diskAvailable = fs.bavail * fs.bsize;
      diskTotal = fs.blocks * fs.bsize;
      break;
    } catch {
      // 数据目录还没建：看根目录
    }
  }
  return {
    load: loadavg()[0] ?? 0,
    cpus: cpus().length,
    memoryAvailable: freemem(),
    memoryTotal: totalmem(),
    diskAvailable,
    diskTotal,
    sandboxes,
  };
}
