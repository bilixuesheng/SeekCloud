import { EventStreamReader } from "./event-stream";

interface InProcessApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

let nextBrowser = 0;

/** 模拟一个浏览器：记住服务器设的 Cookie，后续请求自动带上。每个浏览器有自己的 IP。 */
export class TestBrowser {
  readonly ip = `10.0.${Math.floor(nextBrowser / 250)}.${(nextBrowser++ % 250) + 1}`;
  readonly #app: InProcessApp;
  readonly #cookies = new Map<string, string>();

  constructor(app: InProcessApp) {
    this.#app = app;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", this.ip);
    if (this.#cookies.size > 0) {
      headers.set("cookie", [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const res = await this.#app.request(path, { ...init, headers });
    for (const line of res.headers.getSetCookie()) this.#remember(line);
    return res;
  }

  get(path: string): Promise<Response> {
    return this.request(path);
  }

  post(path: string, body: unknown = {}): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** 打开一条 SSE。连不上（比如 401、404）时报错。 */
  async stream(path: string, headers: Record<string, string> = {}): Promise<EventStreamReader> {
    const res = await this.request(path, { headers });
    if (res.headers.get("content-type") !== "text/event-stream") {
      throw new Error(`${path} 返回 ${res.status}：${await res.text()}`);
    }
    return new EventStreamReader(res);
  }

  #remember(setCookie: string): void {
    const [pair = "", ...attributes] = setCookie.split(";");
    const [name = "", value = ""] = pair.trim().split("=");
    const expired = attributes.some((a) => a.trim().toLowerCase() === "max-age=0");
    if (expired) this.#cookies.delete(name);
    else this.#cookies.set(name, value);
  }
}
