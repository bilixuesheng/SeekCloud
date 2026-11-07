import type { HostCommand, HostEvent } from "@seekcloud/protocol";

/**
 * 主站和宿主机之间的连接。真实的实现是宿主机守护进程连上来的 WebSocket（以后再做），
 * 测试里是 src/testing/fake-host.ts。
 */
export interface HostLink {
  /** 主站启动时调用一次。宿主机按顺序上报事件：等上一个处理完，再交下一个。 */
  connect(onEvent: (event: HostEvent) => Promise<void>): void;
  send(command: HostCommand): void;
}
