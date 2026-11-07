import type { AgentEvent, HostCommand, HostEvent, SafeError } from "@seekcloud/protocol";
import type { HostLink } from "../server/sessions/host";

type CommandOf<T extends HostCommand["type"]> = Extract<HostCommand, { type: T }>;

/**
 * 假宿主机：讲主站和宿主机之间的协议。默认收到"准备沙箱"就回"沙箱好了"，
 * 收到"开始回合"就按脚本回放 Agent 事件。manual 为 true 时不自动回复，由测试用 emit 上报。
 */
export class FakeHost implements HostLink {
  readonly commands: HostCommand[] = [];
  manual = false;
  readonly #scripts: AgentEvent[][] = [];
  #sandboxFailure: SafeError | undefined;
  #onEvent: ((event: HostEvent) => Promise<void>) | undefined;
  #chain: Promise<void> = Promise.resolve();
  #error: unknown;

  connect(onEvent: (event: HostEvent) => Promise<void>): void {
    this.#onEvent = onEvent;
  }

  send(command: HostCommand): void {
    this.commands.push(command);
    if (!this.manual) this.#enqueue(() => this.#respond(command));
  }

  /**
   * 下一个回合回放这些事件。前面自动加"回合开始"；最后不是"回合结束"时，自动加一个正常结束。
   * 没有脚本时，Agent 回一句"收到。"。
   */
  script(...events: AgentEvent[]): void {
    this.#scripts.push(events);
  }

  /** 下一次准备沙箱失败。 */
  failNextSandbox(error: SafeError): void {
    this.#sandboxFailure = error;
  }

  /** 手动上报一个事件，等主站处理完。 */
  emit(event: HostEvent): Promise<void> {
    return this.#enqueue(() => this.#deliver(event));
  }

  /** 等所有排着的事件都处理完。处理时出过错就抛出来。 */
  async idle(): Promise<void> {
    // 处理一个事件时可能又排进新的（比如沙箱好了以后开始回合），等到没有新的为止。
    let current: Promise<void>;
    do {
      current = this.#chain;
      await current;
    } while (current !== this.#chain);
    if (this.#error) throw this.#error;
  }

  last<T extends HostCommand["type"]>(type: T): CommandOf<T> {
    const command = this.commands.findLast((c) => c.type === type);
    if (!command) throw new Error(`宿主机没收到过 ${type}`);
    return command as CommandOf<T>;
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    this.#chain = this.#chain.then(task).catch((error) => {
      this.#error ??= error;
    });
    return this.#chain;
  }

  async #respond(command: HostCommand): Promise<void> {
    if (command.type === "prepare_sandbox") {
      const error = this.#sandboxFailure;
      this.#sandboxFailure = undefined;
      await this.#deliver(
        error
          ? { type: "sandbox.failed", sessionId: command.sessionId, error }
          : { type: "sandbox.ready", sessionId: command.sessionId },
      );
      return;
    }
    // 下发 GitHub 令牌之类的命令不需要回复（命令已经记在 commands 里，测试可以查）。
    if (command.type !== "start_turn") return;
    const script = this.#scripts.shift() ?? [{ type: "message", text: "收到。" }];
    const events: AgentEvent[] = [{ type: "turn.started" }, ...script];
    if (script.at(-1)?.type !== "turn.ended")
      events.push({ type: "turn.ended", reason: "completed" });
    for (const event of events) {
      await this.#deliver({
        type: "agent",
        sessionId: command.sessionId,
        turnId: command.turnId,
        event,
      });
    }
  }

  async #deliver(event: HostEvent): Promise<void> {
    // 像真的网络一样晚一点到。
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!this.#onEvent) throw new Error("主站还没有连上假宿主机");
    await this.#onEvent(event);
  }
}
