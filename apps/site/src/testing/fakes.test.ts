import { describe, expect, it } from "vitest";
import { FakeMailer, FixedRandom } from "./fakes";

// 假时钟的用法见 src/server/health.test.ts。

describe("固定随机数", () => {
  it("按顺序返回给定的值，用完后从头再来", () => {
    const random = new FixedRandom([0.1, 0.5]);

    expect([random.next(), random.next(), random.next()]).toEqual([0.1, 0.5, 0.1]);
  });

  it("拒绝 [0, 1) 以外的值", () => {
    expect(() => new FixedRandom([1])).toThrow();
    expect(() => new FixedRandom([])).toThrow();
  });
});

describe("假邮件", () => {
  it("记下发出的每一封邮件", async () => {
    const mailer = new FakeMailer();

    await mailer.send({ to: "a@example.com", subject: "验证码", text: "123456" });

    expect(mailer.sent).toEqual([{ to: "a@example.com", subject: "验证码", text: "123456" }]);
  });
});
