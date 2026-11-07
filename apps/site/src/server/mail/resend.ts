import type { Mail, Mailer } from "../ports";

/** 用 Resend 的 HTTPS 接口发信（服务器封了 25 端口，不能直接走 SMTP）。 */
export function resendMailer(options: {
  apiKey: string;
  from: string;
  fetch?: typeof globalThis.fetch;
}): Mailer {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async send(mail: Mail) {
      const res = await doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: options.from,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
        }),
      });
      if (!res.ok) throw new Error(`Resend 返回 ${res.status}：${await res.text()}`);
    },
  };
}
