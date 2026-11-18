// SeekCloud 给 dsh 加的逐字输出（#25、#31）：dsh 的 SDK 只推已经存进会话日志的事件，没有模型正在输出的增量。
// 这个插件包住每次模型调用的流（dsh 的 llm/stream 钩子），把思考和正文的增量、用掉的 token 数
// 按行写到环境变量 SEEKCLOUD_LIVE_FD 指的文件描述符（运行器起 dsh 时多开的一条管道），不和 SDK 的标准输出混在一起。
// 没设这个环境变量时什么也不做。一个会话一个 dsh 进程，所以不用分会话。
//
// 每行一个 JSON：
//   { "kind": "thinking" | "text", "text": "…" }   增量
//   { "call": 3, "tokens": 123 }                     第几次模型调用到现在输出了多少 token（思考和正文都算）；
//                                                    一个回合的总数由守护进程按回合加起来
// 只转 Agent 自己的模型调用（dsh 的 isAgentLoopRequest）；压缩上下文这类 dsh 内部的调用不转。
import { createWriteStream, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const name = "seekcloud-live-output";

/** 粗估：没有用量数字时，按字数估 token（中文一个字大约一个 token，英文大约四个字母）。 */
function estimateTokens(text) {
  let cjk = 0;
  for (const ch of text) if (ch.codePointAt(0) > 0x2e80) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** dsh 自己的 @deepseek-ai/dsh-llm（要同一份模块，它的标记才认得）；找不到就当作每次调用都是 Agent 的。 */
async function loadIsAgentLoopRequest() {
  try {
    // dsh 常常经过符号链接启动（镜像里的 /opt/seekcloud/dsh/bin/dsh）：从真的位置找它的依赖
    const require = createRequire(realpathSync(process.argv[1] ?? ""));
    const llm = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-llm")).href);
    if (typeof llm.isAgentLoopRequest === "function") return llm.isAgentLoopRequest;
  } catch {
    // 找不到：下面按"都转"处理
  }
  return () => true;
}

/** @param {{ on(event: string, listener: (...args: any[]) => any): unknown }} ctx */
export async function apply(ctx) {
  const fd = Number(process.env.SEEKCLOUD_LIVE_FD);
  if (!Number.isInteger(fd) || fd < 3) return;
  const out = createWriteStream("", { fd, autoClose: false });
  out.on("error", () => {
    // 运行器那头关了：不影响 dsh 自己
  });
  const write = (line) => out.write(`${JSON.stringify(line)}\n`);
  const isAgentLoopRequest = await loadIsAgentLoopRequest();

  let calls = 0;

  ctx.on("llm/stream", async function* (options, next) {
    if (!isAgentLoopRequest(options)) {
      yield* next();
      return;
    }
    const call = ++calls;
    let estimated = 0;
    let reported = -1;
    const report = (tokens) => {
      if (tokens !== reported) {
        reported = tokens;
        write({ call, tokens });
      }
    };
    for await (const chunk of next()) {
      if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
        write({ kind: chunk.type === "text-delta" ? "text" : "thinking", text: chunk.text });
        estimated += estimateTokens(chunk.text);
        report(estimated);
      } else if (chunk.type === "usage" && typeof chunk.usage?.outputTokens === "number") {
        // 有模型给的数字就用它（它比估的准）
        report(chunk.usage.outputTokens);
      }
      yield chunk;
    }
  });
}
