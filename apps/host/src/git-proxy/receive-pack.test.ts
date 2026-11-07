import { describe, expect, it } from "vitest";
import { isDelete, parseReceivePack, rejectionReport } from "./receive-pack";

const pkt = (s: string) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, "0")}${s}`;
const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

describe("推送请求开头的引用更新命令", () => {
  it("读出每条更新和客户端的能力，后面的打包数据不管", () => {
    const body = Buffer.from(
      `${pkt(`${A} ${B} refs/heads/main\0report-status side-band-64k agent=git/2.43\n`)}${pkt(`${ZERO} ${A} refs/heads/new\n`)}0000PACK....`,
    );
    const parsed = parseReceivePack(body);
    expect(parsed?.updates).toEqual([
      { oldSha: A, newSha: B, ref: "refs/heads/main" },
      { oldSha: ZERO, newSha: A, ref: "refs/heads/new" },
    ]);
    expect(parsed?.capabilities).toContain("report-status");
  });

  it("浅克隆推送时前面的 shallow 行跳过；删除引用能认出来", () => {
    const parsed = parseReceivePack(
      Buffer.from(
        `${pkt(`shallow ${A}\n`)}${pkt(`${A} ${ZERO} refs/heads/old\0report-status\n`)}0000`,
      ),
    );
    expect(parsed?.updates.map(isDelete)).toEqual([true]);
  });

  it("数据还没收全时返回 undefined，格式不对时报错", () => {
    expect(parseReceivePack(Buffer.from(pkt(`${A} ${B} refs/heads/main\n`)))).toBeUndefined();
    expect(parseReceivePack(Buffer.from("00"))).toBeUndefined();
    expect(() => parseReceivePack(Buffer.from("zzzz"))).toThrow();
    expect(() => parseReceivePack(Buffer.from("+01f"))).toThrow();
  });

  it("拒绝时的回复：每个引用一行 ng，要求 side-band 时装进 1 号通道", () => {
    const commands = parseReceivePack(
      Buffer.from(`${pkt(`${A} ${B} refs/tags/v1\0report-status side-band-64k\n`)}0000`),
    );
    if (!commands) throw new Error("没解析出来");
    const report = rejectionReport(commands, new Map([["refs/tags/v1", "不能推送标签"]]));
    expect(report.toString()).toContain("\x01");
    expect(report.toString()).toContain("ng refs/tags/v1 不能推送标签");
    expect(report.toString()).toContain("\x02不能推送标签");
  });
});
