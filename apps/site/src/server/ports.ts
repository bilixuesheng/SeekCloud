// 主站依赖的外部能力。测试里换成 src/testing/fakes 里的假实现。

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
