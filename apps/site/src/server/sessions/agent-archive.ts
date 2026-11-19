import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_AGENT_ARCHIVE_BASE64 } from "@seekcloud/protocol";
import type { AppDeps } from "../app";

/**
 * Agent（dsh）的会话文件（#27）：宿主机每个回合结束时把沙箱里 dsh 的会话目录打包发来，主站存在数据目录下，
 * 每个会话一份，覆盖上一份。沙箱被回收以后重建时，准备沙箱的命令带回去，Agent 接着原来的对话。
 * 删除会话时一起删。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const fileOf = (deps: Pick<AppDeps, "dataDir">, sessionId: string) => {
  if (!UUID.test(sessionId)) throw new Error(`会话 ID 不对：${sessionId}`);
  return join(deps.dataDir, "agent-sessions", `${sessionId}.tar.gz`);
};

/** 存下来（先写临时文件再改名，读的时候不会读到写了一半的）。格式不对、太大的不存，返回 false。 */
export async function saveAgentArchive(
  deps: Pick<AppDeps, "dataDir">,
  sessionId: string,
  base64: string,
): Promise<boolean> {
  if (base64.length === 0 || base64.length > MAX_AGENT_ARCHIVE_BASE64 || !BASE64.test(base64)) {
    return false;
  }
  const file = fileOf(deps, sessionId);
  await mkdir(join(deps.dataDir, "agent-sessions"), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, Buffer.from(base64, "base64"), { mode: 0o600 });
  await rename(temp, file);
  return true;
}

/** 存着的那份（base64），没有就是 undefined。 */
export async function readAgentArchive(
  deps: Pick<AppDeps, "dataDir">,
  sessionId: string,
): Promise<string | undefined> {
  try {
    return (await readFile(fileOf(deps, sessionId))).toString("base64");
  } catch {
    return undefined;
  }
}

export async function removeAgentArchive(
  deps: Pick<AppDeps, "dataDir">,
  sessionId: string,
): Promise<void> {
  await rm(fileOf(deps, sessionId), { force: true });
}
