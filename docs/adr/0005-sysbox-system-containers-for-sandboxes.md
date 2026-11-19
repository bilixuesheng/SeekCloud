# 沙箱用 Docker + Sysbox 系统容器隔离

> **2026-11-15 说明**：下文的"内测规格""内测阶段的廉价 VPS"是迁移过来时的说法。开源版里沙箱的规格可以改（见下面"开源版的做法"）；宿主机还可以装在 Windows 上（WSL2 或 Hyper-V 虚拟机，规格 #117）。Sysbox 的维护状态和 WSL2 上能不能跑已经查过，见 `docs/research/sysbox-2026-11-08.md`。隔离方案的决定不变。
>
> **2026-11-18 补充**：#18 在测试机（4 核 4 GB 的 KVM，Ubuntu 24.04，ext4，Docker 29，Sysbox CE 0.7.1）上验过，结论和开源版的做法见文末。
>
> **2026-11-19 修订**：用户问能不能完全限住单个沙箱的磁盘。改用 XFS 的项目配额做（#168），见文末"磁盘配额"一节，原来"做不到"的那段留着说明为什么要这样绕。

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

## 开源版的做法（2026-11-18，#18）

**规格**：每个沙箱默认 4 核（`--cpus`，共享）、4 GB 内存（`--memory`，不给交换分区），宿主机的环境变量 `SEEKCLOUD_SANDBOX_CPUS`、`SEEKCLOUD_SANDBOX_MEMORY_MB` 可以改。Sysbox 下这两项都生效，沙箱里的 `/sys/fs/cgroup` 也看得到。

**磁盘配额做不到，靠回收兜着**：

- `--storage-opt size=` 在 Sysbox 加 ext4 上不报错，但不生效（测试机上限 1 GB 的容器照样看到整块 49 GB 的盘）。Docker 只在 overlay2 底下是开了项目配额的 XFS、或者 btrfs、zfs 时才限得住。
- 就算限得住，Sysbox 把沙箱里的 `/var/lib/docker` 放在宿主机的 `/var/lib/sysbox` 下面，沙箱里 Docker 拉的镜像和建的卷不在配额里。
- 所以单个沙箱现在没有磁盘配额：宿主机上报 `diskQuota: false`，运行状况里写明"磁盘配额不生效"，靠宿主机磁盘超过 80% 时先回收休眠最久的沙箱兜着（调度 #45）。以后要做，方向是给每个沙箱的工作目录和 `/var/lib/docker` 各挂一个限了大小的卷。（2026-11-19 改了，见下面"磁盘配额"。）

**磁盘配额**（2026-11-19，#168）：照 Claude Code 网页版，每个沙箱一份固定的额度，用完了写文件报 `No space left on device`，删了马上又能写。

- **宿主机的存储**：Docker（包括 containerd）、Sysbox 和沙箱自己的数据放在一块开了项目配额（`prjquota`）的 XFS 上。
  - 系统盘是 ext4 时，引导脚本建一个镜像文件，格式化成 XFS 用 loop 挂上，不用重新分区。
  - 镜像文件用 `fallocate` 一次占满，不用稀疏文件：稀疏文件在宿主机盘满时，里面的文件系统会出 I/O 错。
  - `/var/lib/docker`、`/var/lib/containerd`、`/var/lib/sysbox`、`/var/lib/seekcloud` 用 bind 挂过去。
  - 测试机是 `scripts/test-machine.sh` 的"沙箱的存储"一步；正式的安装脚本（#94）照它做。
- **每个沙箱一个项目编号**，记在容器标签 `cn.seekcloud.quota-project` 上。下面两块设成这个项目，共用一个上限（`SEEKCLOUD_SANDBOX_DISK_GB`，默认 30）：
  - **沙箱的可写层**：容器根目录 overlay 的 `upperdir` 和 `workdir`。
    - 从容器第一个进程的 mountinfo 读。Docker 29 默认用 containerd 的快照，`docker inspect` 里没有这两个路径，mountinfo 里有。
    - 两个都设：XFS 不让跨项目 rename，只设 `upperdir` 时，overlay 往上层拷文件会失败。
  - **沙箱里的 `/var/lib/docker`**：不用 Sysbox 自动给的那块（它在 `/var/lib/sysbox` 下面，不在容器的配额里），改挂宿主机上这个沙箱自己的目录 `<SEEKCLOUD_SANDBOX_DATA>/<会话>/docker`（Sysbox 支持在这里挂卷）。
    - 顺带的好处：休眠再启动时，沙箱里拉的镜像原样还在，不用 Sysbox 在停止时搬一遍。
    - 删沙箱时，守护进程把这个目录一起删掉。
- **存储不支持时照旧不限**：不是 XFS、没开 `prjquota`、没装 xfsprogs，都照旧不限，上报 `diskQuota: false`，启动日志写明原因。宿主机磁盘超过 80% 时回收沙箱，这条照旧兜底。
- **已经是这个项目的目录**（休眠后唤醒）：不再整棵树重设，只重设上限。

**网络隔离**（#18 评论第 4 条）：

- 沙箱用专用的 Docker 网络 `seekcloud-sandbox`，网桥叫 `seekcloud0`，关掉容器之间的互通（`enable_icc=false`），沙箱之间连不通。
- 宿主机给沙箱的服务（Git 代理、签名、各种转发）只监听网桥上的地址。
- 测试机上验过：不加规则时，沙箱连得上宿主机的 SSH。所以 INPUT 链里从 `seekcloud0` 进来的流量跳到我们自己的链 `SEEKCLOUD-SANDBOX`，只放行网桥地址上给沙箱的那几个端口，别的端口 TCP 回复位、其余丢掉（IPv6 也一样）。沙箱出去上网走转发，不受影响。
- 规则用 `iptables-restore --noflush` 一次换完，写进内核，不依赖守护进程活着。网络或者规则有一样没准备好，守护进程就不建沙箱。
- 所以守护进程要用 root 跑。

**内存用满时先杀谁**：

- 沙箱里的进程 `oom_score_adj` 是 300，比宿主机自己的进程先被杀。
- Agent（dsh）由宿主机调到 -500。沙箱里的 root 调不低自己的值，要宿主机的 root。这样沙箱的内存用满时，内核先杀占内存多的构建进程。

**守护进程重启**：

- 沙箱是带标签（`cn.seekcloud.sandbox`、`cn.seekcloud.session`）的容器，不依赖守护进程这个进程。守护进程退出、重启，沙箱和里面的后台命令照常跑；重启后按标签认回来，不重复建。
- 容器不设重启策略：宿主机重启后，沙箱由主站重新准备时再启动。

**沙箱里跑的命令**：

- 宿主机在沙箱里跑的命令（`docker exec`）参数一律是数组，不经过 shell。
- 超时时，按每个命令带着的环境变量标记，杀掉它起的所有进程，别的命令起的不动。

镜像由 `SEEKCLOUD_SANDBOX_IMAGE` 指定，通用镜像在 #17 里做；没配时守护进程不建沙箱。

