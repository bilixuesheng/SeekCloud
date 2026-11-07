import { describe, expect, it } from "vitest";
import { FakeMailer } from "./fakes";

// 假时钟的用法见 src/server/health.test.ts。

describe("假邮件", () => {
  it("记下发出的每一封邮件", async () => {
    const mailer = new FakeMailer();

    await mailer.send({ to: "a@example.com", subject: "验证码", text: "123456" });

    expect(mailer.sent).toEqual([{ to: "a@example.com", subject: "验证码", text: "123456" }]);
  });
});
