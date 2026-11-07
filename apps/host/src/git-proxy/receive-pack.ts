// git 推送（git-receive-pack）请求的开头是一串 pkt-line 格式的引用更新命令，后面才是打包的对象。
// 代理只读开头这几行，判断要不要放行，不碰后面的对象。

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

export interface ReceivePackCommands {
  updates: RefUpdate[];
  capabilities: string[];
}

const ZERO_SHA = /^0+$/;

/** 新值是全 0：删除这个引用。 */
export const isDelete = (update: RefUpdate) => ZERO_SHA.test(update.newSha);

/**
 * 从请求体开头解析引用更新命令。数据还不够时返回 undefined（等更多数据）；
 * 格式不对时抛错（代理按"拒绝"处理）。
 */
export function parseReceivePack(data: Buffer): ReceivePackCommands | undefined {
  const updates: RefUpdate[] = [];
  let capabilities: string[] = [];
  let offset = 0;
  for (;;) {
    if (data.length < offset + 4) return undefined;
    const hex = data.subarray(offset, offset + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error("推送请求的格式不对");
    const size = Number.parseInt(hex, 16);
    if (size === 0) return { updates, capabilities };
    if (size < 4) throw new Error("推送请求的格式不对");
    if (data.length < offset + size) return undefined;
    let line = data.subarray(offset + 4, offset + size).toString("utf8");
    offset += size;
    if (line.endsWith("\n")) line = line.slice(0, -1);
    // 浅克隆推送时，命令前面会先列出 shallow 的提交。
    if (line.startsWith("shallow ")) continue;
    const nul = line.indexOf("\0");
    if (nul !== -1) {
      capabilities = line
        .slice(nul + 1)
        .split(" ")
        .filter(Boolean);
      line = line.slice(0, nul);
    }
    const [oldSha, newSha, ref] = line.split(" ");
    if (!oldSha || !newSha || !ref) throw new Error(`看不懂的推送命令：${line}`);
    updates.push({ oldSha, newSha, ref });
  }
}

const pkt = (payload: Buffer | string) => {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};

const FLUSH = Buffer.from("0000");

/**
 * 拒绝整次推送时给 git 的回复（report-status）。git 会显示成
 * "! [remote rejected] 引用 (原因)"，Agent 能看到具体原因。
 */
export function rejectionReport(commands: ReceivePackCommands, reasons: Map<string, string>) {
  const lines = [
    pkt("unpack ok\n"),
    ...commands.updates.map((u) =>
      pkt(
        `ng ${u.ref} ${reasons.get(u.ref) ?? "同一次推送里有被拒绝的引用，整次推送都没有执行"}\n`,
      ),
    ),
    FLUSH,
  ];
  const report = Buffer.concat(lines);
  if (!commands.capabilities.some((c) => c.startsWith("side-band"))) return report;
  // 客户端要求 side-band 时，回复要装在 1 号通道里；顺便在 2 号通道打一行说明。
  const messages = [...new Set(reasons.values())].map((m) => pkt(Buffer.from(`\x02${m}\n`)));
  return Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), report])), ...messages, FLUSH]);
}
