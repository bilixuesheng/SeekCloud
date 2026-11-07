import { describe, expect, it } from "vitest";
import { resendMailer } from "./resend";

const mail = { to: "alice@example.com", subject: "SeekCloud 登录验证码", text: "123456" };

describe("Resend 发信", () => {
  it("用 API Key 调 Resend 的发信接口", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mailer = resendMailer({
      apiKey: "re_test",
      from: "SeekCloud <noreply@seekcloud.test>",
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      },
    });

    await mailer.send(mail);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer re_test");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      from: "SeekCloud <noreply@seekcloud.test>",
      to: ["alice@example.com"],
      subject: "SeekCloud 登录验证码",
      text: "123456",
    });
  });

  it("Resend 返回错误时抛出异常，带上状态码", async () => {
    const mailer = resendMailer({
      apiKey: "re_test",
      from: "SeekCloud <noreply@seekcloud.test>",
      fetch: async () => new Response('{"message":"invalid from"}', { status: 422 }),
    });

    await expect(mailer.send(mail)).rejects.toThrow("422");
  });
});
