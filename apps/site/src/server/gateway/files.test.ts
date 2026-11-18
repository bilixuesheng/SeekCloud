import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayRequest, startSession } from "../../testing/gateway-client";
import { createTestApp, MODEL_KEY, type TestApp } from "../../testing/test-app";
import type { TestBrowser } from "../../testing/test-browser";
import { modelFiles, upstreamErrors } from "../db/schema";

/** 模型网关的 Files 接口（#26）：dsh 把图片传给提供方，Messages 里按文件 ID 引用。每个会话只碰得到自己传的。 */
describe("模型网关的 Files 接口", () => {
  let t: TestApp;
  let browser: TestBrowser;
  let mine: string;
  let other: string;

  beforeAll(async () => {
    t = await createTestApp();
    ({ browser } = await t.adminWithGitHub("octo", "octo/app"));
    mine = (await startSession(t, browser, "octo/app")).sessionId;
    other = (await startSession(t, browser, "octo/app", "另一个")).sessionId;
  });
  afterAll(() => t.close());

  const image = (name = "seekcloud-a.png", size = 64) => {
    const form = new FormData();
    form.set("expires_after[anchor]", "created_at");
    form.set("expires_after[seconds]", "3600");
    form.set("file", new Blob([new Uint8Array(size).fill(7)], { type: "image/png" }), name);
    return form;
  };
  const upload = async (session: string, name?: string) => {
    const res = await gatewayRequest(t, session, "/v1/files", {
      body: image(name),
      headers: {
        "anthropic-beta": "files-api-2025-04-14",
        "x-deepseek-harness-user-id": "anon-1",
        "x-api-key": "session-token",
      },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; [key: string]: unknown };
  };
  const ask = (content: unknown) => ({
    model: "deepseek-flash",
    max_tokens: 100,
    messages: [{ role: "user", content }],
  });
  const imageBlock = (fileId: string) => ({
    type: "image",
    source: { type: "file", file_id: fileId },
  });

  it("上传：multipart 原样转给提供方，换上 key，不带夹带的请求头；回给沙箱的只有文件的几项信息", async () => {
    const file = await upload(mine);
    expect(file).toEqual({
      type: "file",
      id: file.id,
      filename: "seekcloud-a.png",
      mime_type: "image/png",
      size_bytes: 64,
      created_at: expect.any(String),
      downloadable: false,
    });
    const sent = t.model.requests.at(-1);
    expect(sent?.url).toBe("https://model.test/anthropic/v1/files");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("x-api-key")).toBe(MODEL_KEY);
    expect(sent?.headers.get("anthropic-beta")).toBe("files-api-2025-04-14");
    expect(sent?.headers.get("authorization")).toBeNull();
    expect(sent?.headers.get("x-seekcloud-session")).toBeNull();
    expect(sent?.headers.get("x-deepseek-harness-user-id")).toBeNull();
    expect(sent?.form?.get("expires_after[seconds]")).toBe("3600");
    expect((sent?.form?.get("file") as File | undefined)?.size).toBe(64);

    const [row] = await t.db.select().from(modelFiles).where(eq(modelFiles.id, file.id));
    expect(row).toMatchObject({ sessionId: mine, provider: "deepseek", sizeBytes: 64 });
  });

  it("不是 multipart 的上传：直接拒绝，不转发", async () => {
    const before = t.model.requests.length;
    const res = await gatewayRequest(t, mine, "/v1/files", { body: { file: "x" } });
    expect(res.status).toBe(400);
    expect(t.model.requests.length).toBe(before);
  });

  it("列表只有本会话传的，新的在前，能用 after_id 和 before_id 翻页", async () => {
    const fresh = (await startSession(t, browser, "octo/app", "翻页")).sessionId;
    const ids = [];
    for (const name of ["1.png", "2.png", "3.png"]) ids.push((await upload(fresh, name)).id);
    const list = async (query: string) =>
      (await (await gatewayRequest(t, fresh, `/v1/files${query}`)).json()) as {
        data: { id: string }[];
        first_id: string | null;
        last_id: string | null;
        has_more: boolean;
      };

    const first = await list("?limit=2");
    expect(first.data.map((f) => f.id)).toEqual([ids[2], ids[1]]);
    expect(first.has_more).toBe(true);
    const second = await list(`?limit=2&after_id=${first.last_id}`);
    expect(second.data.map((f) => f.id)).toEqual([ids[0]]);
    expect(second.has_more).toBe(false);
    const back = await list(`?limit=1&before_id=${ids[0]}`);
    expect(back.data.map((f) => f.id)).toEqual([ids[1]]);
    expect(back.has_more).toBe(true);
    expect((await list("")).data).toHaveLength(3);
    expect((await gatewayRequest(t, fresh, "/v1/files?limit=0")).status).toBe(400);
  });

  it("别的会话看不到、删不掉、引用不了我的文件，按不存在回", async () => {
    const file = await upload(mine, "secret.png");
    const before = t.model.requests.length;

    const theirs = (await (await gatewayRequest(t, other, "/v1/files")).json()) as {
      data: { id: string }[];
    };
    expect(theirs.data.map((f) => f.id)).not.toContain(file.id);
    expect((await gatewayRequest(t, other, `/v1/files/${file.id}`)).status).toBe(404);
    expect(
      (await gatewayRequest(t, other, `/v1/files/${file.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect((await gatewayRequest(t, other, `/v1/files?after_id=${file.id}`)).status).toBe(404);
    const referenced = await gatewayRequest(t, other, "/v1/messages", {
      body: ask([imageBlock(file.id), { type: "text", text: "这是什么" }]),
    });
    expect(referenced.status).toBe(400);
    // 藏在工具结果里的也查
    const nested = await gatewayRequest(t, other, "/v1/messages", {
      body: ask([{ type: "tool_result", tool_use_id: "t1", content: [imageBlock(file.id)] }]),
    });
    expect(nested.status).toBe(400);
    expect(t.model.requests.length).toBe(before);

    // 我自己的照常能看、能引用
    expect((await gatewayRequest(t, mine, `/v1/files/${file.id}`)).status).toBe(200);
    const ok = await gatewayRequest(t, mine, "/v1/messages", {
      body: ask([imageBlock(file.id), { type: "text", text: "这是什么" }]),
    });
    expect(ok.status).toBe(200);
    await ok.text();
    expect(t.model.requests.length).toBe(before + 1);
  });

  it("工具参数里长得像文件引用的东西不算引用", async () => {
    const res = await gatewayRequest(t, mine, "/v1/messages", {
      body: {
        model: "deepseek-flash",
        max_tokens: 100,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "write",
                input: { source: { type: "file", file_id: "file_not_ours" } },
              },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "好" }] },
        ],
      },
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it("删除：提供方那边删掉，记录也删；提供方那边已经没了（过期）也算删掉", async () => {
    const file = await upload(mine, "gone.png");
    const res = await gatewayRequest(t, mine, `/v1/files/${file.id}`, { method: "DELETE" });
    expect(await res.json()).toEqual({ id: file.id, type: "file_deleted" });
    expect(t.model.requests.at(-1)?.method).toBe("DELETE");
    expect(t.model.files.has(file.id)).toBe(false);
    expect((await gatewayRequest(t, mine, `/v1/files/${file.id}`)).status).toBe(404);

    const expired = await upload(mine, "expired.png");
    t.model.files.delete(expired.id);
    const again = await gatewayRequest(t, mine, `/v1/files/${expired.id}`, { method: "DELETE" });
    expect(again.status).toBe(200);
    expect(await t.db.select().from(modelFiles).where(eq(modelFiles.id, expired.id))).toEqual([]);
  });

  it("上传时上游出错：沙箱只收到我们的说明、状态码和参考号，原始报错按参考号存下", async () => {
    t.model.reply({
      status: 413,
      body: '{"error":{"message":"file too large for org org_secret_123 at https://internal"}}',
    });
    const res = await gatewayRequest(t, mine, "/v1/files", { body: image() });
    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).not.toContain("org_secret_123");
    expect(text).not.toContain("internal");
    const ref = /参考号 (\w+)/.exec(text)?.[1] as string;
    const [stored] = await t.db.select().from(upstreamErrors).where(eq(upstreamErrors.ref, ref));
    expect(stored?.body).toContain("org_secret_123");
  });

  it("没有的接口按 Anthropic 的格式回 404；不提供下载文件内容", async () => {
    const file = await upload(mine, "c.png");
    const content = await gatewayRequest(t, mine, `/v1/files/${file.id}/content`);
    expect(content.status).toBe(404);
    expect((await content.json()).type).toBe("error");
    expect((await gatewayRequest(t, mine, "/v1/nothing")).status).toBe(404);
  });

  it("没有宿主机凭据：Files 接口同样拒绝", async () => {
    const res = await t.request(`/api/gateway/v1/files`, {
      headers: { "x-seekcloud-session": mine },
    });
    expect(res.status).toBe(401);
  });
});
