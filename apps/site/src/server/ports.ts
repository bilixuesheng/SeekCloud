// 主站依赖的外部能力。测试里换成 src/testing/fakes 里的假实现。

export interface Clock {
  now(): Date;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export const systemClock: Clock = { now: () => new Date() };

/** 没配 Resend 时发信直接报错，免得验证码之类的内容被打进日志。 */
export const unconfiguredMailer: Mailer = {
  send: async () => {
    throw new Error("发信服务还没有配置");
  },
};
