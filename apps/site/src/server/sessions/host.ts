import type { HostCommand, HostEvent } from "@seekcloud/protocol";

/**
 * 主站和宿主机之间的连接。真实的实现是 hosts/hub.ts 的 HostHub（宿主机守护进程用 WebSocket 连上来，
 * 可以有好几台），测试里是 src/testing/fake-host.ts。
 */
export interface HostLink {
  /**
   * 主站启动时调用一次。宿主机按顺序上报事件：等上一个处理完，再交下一个。
   * onAvailable：原来没有能接新会话的宿主机、现在有了（比如一台宿主机连上来）时调用，主站把排队的会话派出去。
   */
  connect(onEvent: (event: HostEvent) => Promise<void>, onAvailable?: () => void): void;
  /** 现在有没有能接新会话的宿主机。没有时新会话留在排队中。 */
  available(): boolean;
  send(command: HostCommand): void;
  /**
   * 宿主机替沙箱转发到主站的请求（模型网关这些）带的宿主机凭据，是哪台宿主机的。不认得时返回 undefined。
   */
  verifyCredential(token: string): { id: string; name: string } | undefined;
  /** 这个会话是不是在这台宿主机上：宿主机只能替自己名下的会话转发请求。 */
  owns(hostId: string, sessionId: string): Promise<boolean>;
}
