# 沙箱用 Docker + Sysbox 系统容器隔离

每个沙箱是沙箱宿主机上的一个 Sysbox 系统容器（运行时为 `sysbox-runc`），不是普通 Docker 容器，也不是 microVM。这样定有三个原因：

- **能在沙箱里跑 Docker**：每个沙箱里有自己的 Docker 守护进程，用户可以 `docker compose up`，和 Claude Code 云端一样。
- **隔离比普通 Docker 强**：开启了用户命名空间，容器里的 root 映射成宿主机上的普通用户。
- **便宜**：普通的 KVM 虚拟机就能跑，不需要嵌套虚拟化，内测阶段的廉价 VPS 也能用。

内测规格：每个沙箱 4 核（共享）、4 GB 内存、30 GB 磁盘配额，资源适度超卖。宿主机磁盘用量超过 80% 时，先回收休眠最久的沙箱。

## Considered Options

- **microVM**（Firecracker、Kata，Claude 那样每个会话一台 VM）：隔离最强，但需要嵌套虚拟化或物理机。成本太高，等规模上来再说。
- **特权 Docker-in-Docker**：没有采用。一旦逃逸，拿到的就是宿主机 root，而 Git 代理就跑在宿主机上（ADR 0003）。
- **普通 Docker，不支持沙箱内 Docker**：没有采用。体验和 Claude 差距太大。

## Consequences

- 宿主机必须是 KVM 一类的完整虚拟机。LXC、OpenVZ 跑不了 Sysbox，所以买机器后要在退款期内先验证。
- Sysbox 在 2026 年的维护状态还没核实，买机器后一起验证。
