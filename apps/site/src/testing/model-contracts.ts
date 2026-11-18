import { describe, expect, it } from "vitest";
import type {
  ErrorPresentation,
  ModelAdmission,
  ModelCall,
  ProviderRouting,
  UpstreamFailure,
} from "../server/ports";

/**
 * 模型网关三个扩展点的契约（ADR 0010）：主干的实现和下游的实现都要通过。
 * 每个接受一个 setup：建好要测的实现（比如已经填好 key 的提供方路由），测完收拾。
 */

const call = (model = "deepseek-flash"): ModelCall => ({
  purpose: "agent",
  userId: null,
  sessionId: null,
  turnId: null,
  model,
});

/** dsh 发来的请求长什么样：夹带的字段、请求头，加上宿主机转发时带的凭据和会话。 */
const harnessRequest = () => ({
  headers: new Headers({
    authorization: "Bearer host-credential-must-not-leak",
    "x-seekcloud-session": "00000000-0000-4000-8000-000000000000",
    "x-api-key": "session-token-must-not-leak",
    "x-deepseek-harness-user-id": "anon-1",
    "x-deepseek-harness-compact": "1",
    "user-agent": "dsh/0.2.2",
    cookie: "sc_login=must-not-leak",
    "anthropic-version": "2023-06-01",
  }),
  body: {
    model: "deepseek-flash",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    dsh_session_log: { secret: true },
    dsh_plugin_packages: ["x"],
    metadata: { user_id: "anon-1" },
  } as Record<string, unknown>,
});

function expectNoLeaks(headers: Headers) {
  const sent = [...headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  for (const leak of [
    "x-deepseek-harness",
    "host-credential-must-not-leak",
    "session-token-must-not-leak",
    "must-not-leak",
    "x-seekcloud-session",
    "dsh/",
  ]) {
    expect(sent, leak).not.toContain(leak);
  }
}

export function describeProviderRoutingContract(
  name: string,
  setup: () => Promise<{ routing: ProviderRouting; close(): Promise<void> }>,
) {
  describe(`提供方路由的契约：${name}`, () => {
    it("认得的模型至少有一个提供方；不认得的模型一个都没有", async () => {
      const { routing, close } = await setup();
      try {
        expect((await routing.route("deepseek-flash", call())).length).toBeGreaterThan(0);
        expect(await routing.route("no-such-model", call("no-such-model"))).toEqual([]);
      } finally {
        await close();
      }
    });

    it("改写后的请求：没有 dsh 夹带的字段和请求头、没有 user_id，也不带宿主机凭据、会话令牌和 Cookie", async () => {
      const { routing, close } = await setup();
      try {
        for (const target of await routing.route("deepseek-flash", call())) {
          const input = harnessRequest();
          const before = JSON.stringify(input.body);
          const { headers, body } = target.prepare(input);
          expect(Object.keys(body).filter((k) => k.startsWith("dsh_"))).toEqual([]);
          expect(JSON.stringify(body.metadata ?? {})).not.toContain("user_id");
          expect(typeof body.model).toBe("string");
          expectNoLeaks(headers);
          expect(target.url("/v1/messages")).toMatch(/^https?:\/\/.+\/v1\/messages$/);
          // 不改动传进来的对象（网关要拿它去试下一个提供方）
          expect(JSON.stringify(input.body)).toBe(before);
        }
      } finally {
        await close();
      }
    });

    it("Files 和联网搜索：有可用的提供方；各个接口的请求头同样不带夹带的东西", async () => {
      const { routing, close } = await setup();
      try {
        for (const service of ["files", "web_search"] as const) {
          const targets = await routing.service({ service, userId: null, sessionId: null });
          expect(targets.length, service).toBeGreaterThan(0);
          for (const target of targets) {
            for (const path of ["/v1/files", "/v1/files/file_1", "/v1/tools/search"]) {
              expectNoLeaks(target.headers(path, harnessRequest().headers));
              expect(target.url(path)).toMatch(new RegExp(`^https?://[^/]+(/.*)?${path}$`));
            }
          }
        }
      } finally {
        await close();
      }
    });
  });
}

export function describeModelAdmissionContract(
  name: string,
  setup: () => Promise<{ admission: ModelAdmission; close(): Promise<void> }>,
) {
  describe(`模型调用准入和记录的契约：${name}`, () => {
    it("准入的答复只有两种：放行，或者不放行加一句说明", async () => {
      const { admission, close } = await setup();
      try {
        const answer = await admission.admit(call());
        if (answer.ok) expect(answer).toEqual({ ok: true });
        else expect(typeof answer.message).toBe("string");
      } finally {
        await close();
      }
    });

    it("联网工具的准入也只有两种答复；成功的、出错的都能记，不抛错", async () => {
      const { admission, close } = await setup();
      try {
        const tool = { userId: null, sessionId: null, turnId: null };
        const answer = await admission.admitWebTool({ tool: "web_search", ...tool });
        if (answer.ok) expect(answer).toEqual({ ok: true });
        else expect(typeof answer.message).toBe("string");
        await admission.recordWebTool({
          tool: "web_search",
          ...tool,
          provider: "deepseek",
          ok: true,
        });
        await admission.recordWebTool({ tool: "web_fetch", ...tool, provider: null, ok: false });
      } finally {
        await close();
      }
    });

    it("完成的、没完成的、出错的调用都能记，不抛错", async () => {
      const { admission, close } = await setup();
      try {
        const tokens = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
        await admission.record({ ...call(), provider: "deepseek", ...tokens, complete: true });
        await admission.record({
          ...call(),
          purpose: "title",
          provider: "deepseek",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          complete: false,
        });
      } finally {
        await close();
      }
    });
  });
}

export function describeErrorPresentationContract(name: string, presentation: ErrorPresentation) {
  describe(`报错呈现的契约：${name}`, () => {
    const failure: UpstreamFailure = {
      ref: "k3x9ab2c",
      code: "model_unavailable",
      status: 503,
      provider: "deepseek",
      upstream: { status: 503, body: "upstream says no" },
      createdAt: "2026-11-18T00:00:00.000Z",
    };

    it("至少给出类别和参考号（浏览器按类别写说明，用户报问题时给参考号），能转成 JSON", () => {
      const shown = presentation.present(failure, { id: "u1" });
      expect(shown.code).toBe("model_unavailable");
      expect(shown.ref).toBe("k3x9ab2c");
      expect(JSON.parse(JSON.stringify(shown))).toEqual(shown);
    });
  });
}
