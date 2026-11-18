import { LinkPeer, negotiateProtocol } from "@seekcloud/protocol";
import { describe, expect, it } from "vitest";

describe("LinkPeer：序号和补发", () => {
  it("发出去的帧按顺序编号，对方确认之前都留着，确认以后清掉", () => {
    const peer = new LinkPeer<string>({ maxPending: 10 });
    expect(peer.send("a").seq).toBe(1);
    expect(peer.send("b").seq).toBe(2);
    expect(peer.send("c").seq).toBe(3);
    peer.acknowledge(2);
    expect(peer.unacknowledged().map((f) => f.payload)).toEqual(["c"]);
    // 晚到的旧确认不会把清掉的找回来
    peer.acknowledge(1);
    expect(peer.pendingCount).toBe(1);
  });

  it("收到的帧：处理过的序号算重复；处理完才往前推，ack 跟着带出去", () => {
    const peer = new LinkPeer<string>({ maxPending: 10 });
    expect(peer.accept(1)).toBe(true);
    peer.processed(1);
    expect(peer.accept(1)).toBe(false);
    // 序号可以跳（对方丢了只推送的帧）
    expect(peer.accept(5)).toBe(true);
    peer.processed(5);
    expect(peer.received).toBe(5);
    expect(peer.send("x").ack).toBe(5);
  });

  it("对方重启过：已处理的位置清零，它从 1 重新数的帧照收", () => {
    const peer = new LinkPeer<string>({ maxPending: 10 });
    peer.processed(42);
    peer.peerRestarted();
    expect(peer.accept(1)).toBe(true);
  });

  it("补发队列满了：先丢最旧的只推送的帧，要落库的一条不丢", () => {
    const peer = new LinkPeer<{ live: boolean; n: number }>({
      maxPending: 3,
      isLive: (p) => p.live,
    });
    peer.send({ live: false, n: 1 });
    peer.send({ live: true, n: 2 });
    peer.send({ live: true, n: 3 });
    peer.send({ live: false, n: 4 });
    expect(peer.unacknowledged().map((f) => f.payload.n)).toEqual([1, 3, 4]);
    peer.send({ live: false, n: 5 });
    expect(peer.unacknowledged().map((f) => f.payload.n)).toEqual([1, 4, 5]);
    // 全是要落库的：宁可超过上限也不丢
    peer.send({ live: false, n: 6 });
    expect(peer.unacknowledged().map((f) => f.payload.n)).toEqual([1, 4, 5, 6]);
  });
});

describe("协议版本", () => {
  it("取两边都会说的最新版本；说不到一起时为空", () => {
    expect(
      negotiateProtocol({ protocol: 1, minProtocol: 1 }, { protocol: 1, minProtocol: 1 }),
    ).toBe(1);
    // 宿主机新一个版本、还会说旧的：用旧的
    expect(
      negotiateProtocol({ protocol: 1, minProtocol: 1 }, { protocol: 2, minProtocol: 1 }),
    ).toBe(1);
    // 主站新一个版本、还会说旧的
    expect(
      negotiateProtocol({ protocol: 2, minProtocol: 1 }, { protocol: 1, minProtocol: 1 }),
    ).toBe(1);
    // 差两个版本
    expect(
      negotiateProtocol({ protocol: 3, minProtocol: 2 }, { protocol: 1, minProtocol: 1 }),
    ).toBeNull();
  });
});
