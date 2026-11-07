import { purgeAccessLogs } from "./access-log";
import { buildPendingExports, expireExports } from "./account/exports";
import type { AppDeps } from "./app";

/**
 * 后台的定期任务：打包等着的数据导出、删掉过期的导出、删掉满 180 天的访问记录。
 * main.ts 每分钟跑一次；测试里直接调用（t.runMaintenance()），配合假时钟。
 * 每一项自己出错不影响其他几项。
 */
export async function runMaintenance(deps: AppDeps): Promise<void> {
  const jobs: Array<[string, () => Promise<unknown>]> = [
    ["打包数据导出", () => buildPendingExports(deps)],
    ["清理过期的导出", () => expireExports(deps)],
    ["清理过期的访问记录", () => purgeAccessLogs(deps)],
  ];
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (error) {
      console.error(`定期任务出错：${name}`, error);
    }
  }
}

/** 每隔一段时间跑一次；上一次还没跑完就跳过这一次，不叠在一起。 */
export function startMaintenance(deps: AppDeps, intervalMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runMaintenance(deps);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
