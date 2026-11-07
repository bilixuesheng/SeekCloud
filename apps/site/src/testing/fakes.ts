import type { Clock, Mail, Mailer, Random } from "../server/ports";

export class FakeClock implements Clock {
  #now: Date;

  constructor(start = new Date("2026-01-01T00:00:00Z")) {
    this.#now = new Date(start);
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}

/** 按顺序返回给定的值，用完后从头再来。 */
export class FixedRandom implements Random {
  #values: number[];
  #index = 0;

  constructor(values: number[] = [0]) {
    if (values.length === 0 || values.some((v) => v < 0 || v >= 1)) {
      throw new Error("FixedRandom 需要至少一个 [0, 1) 之间的值");
    }
    this.#values = values;
  }

  next(): number {
    const value = this.#values[this.#index % this.#values.length] as number;
    this.#index++;
    return value;
  }
}

export class FakeMailer implements Mailer {
  readonly sent: Mail[] = [];
  #nextFailure: Error | undefined;

  /** 下一次发信失败，模拟发信服务出问题。 */
  failNext(error = new Error("发信服务不可用")): void {
    this.#nextFailure = error;
  }

  async send(mail: Mail): Promise<void> {
    const failure = this.#nextFailure;
    this.#nextFailure = undefined;
    if (failure) throw failure;
    this.sent.push(mail);
  }
}
