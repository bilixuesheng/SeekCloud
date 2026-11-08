import type { Clock, Mail, Mailer } from "../server/ports";

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
