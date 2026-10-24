/**
 * SSE 解析测试。
 *
 * 这些用例用真实的上游帧格式（见 docs/contracts.md §2），
 * 覆盖分帧、keep-alive、坏帧容错与失败序列。
 *
 * 测试策略：用本地 HTTP 服务器返回真实的 SSE 响应，
 * 从而走完整的 transport → adapter → collector 链路，而不是只测一个孤立函数。
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LLMAdapter,
  UpstreamRejectedError,
  UpstreamUnavailableError,
} from "../src/upstream/adapters.js";
import type { LLMEvent, MetaFrame, RouteFrame } from "../src/contracts/index.js";

let server: Server;
let base = "";

/**
 * 适配器固定请求 /v1/events，因此用一个「当前剧本」变量切换每个用例的响应内容。
 * 这比按路径注册更贴近真实：真实上游也只有一个事件端点。
 */
let currentChunks: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    });
    const chunks = currentChunks;
    if (chunks.length === 0) {
      res.end();
      return;
    }
    let index = 0;
    const writeNext = (): void => {
      if (index >= chunks.length) {
        res.end();
        return;
      }
      res.write(chunks[index]);
      index += 1;
      setTimeout(writeNext, 1);
    };
    writeNext();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        base = `http://127.0.0.1:${address.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function adapterFor(chunks: string[]): LLMAdapter {
  currentChunks = chunks;
  return new LLMAdapter(base);
}

const frame = (name: string, payload: unknown): string =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

const deltaPayload = (content: string) => ({
  event_id: "e1",
  session_id: "s1",
  content,
  stream: true,
  tags: { emotion: "neutral", type: "text", intent: "reply" },
});

const finalPayload = (content: string, emotion = "comfort") => ({
  event_id: "e1",
  session_id: "s1",
  content,
  stream: false,
  tags: { emotion, type: "text", intent: "reply" },
});

describe("LLMAdapter SSE 解析", () => {
  it("按契约顺序解析 meta → route → delta → final", async () => {
    const metas: MetaFrame[] = [];
    const routes: RouteFrame[] = [];
    const deltas: LLMEvent[] = [];

    const adapter = adapterFor([
      frame("meta", { event_id: "e1", session_id: "s1", planned_model: "echo:echo" }),
      frame("route", { provider: "echo", model: "echo:echo", fallback: false }),
      frame("delta", deltaPayload("我在")),
      frame("delta", deltaPayload("我在呢")),
      frame("final", finalPayload("我在呢，慢慢说。")),
    ]);

    const final = await adapter.runTurn(
      { eventId: "e1", text: "hi" },
      {
        onMeta: (m) => metas.push(m),
        onRoute: (r) => routes.push(r),
        onDelta: (d) => deltas.push(d),
      },
    );

    expect(metas).toHaveLength(1);
    expect(metas[0]?.planned_model).toBe("echo:echo");
    expect(routes[0]?.provider).toBe("echo");
    expect(deltas).toHaveLength(2);
    expect(final.content).toBe("我在呢，慢慢说。");
    expect(final.tags.emotion).toBe("comfort");
  });

  it("忽略 keep-alive 注释行", async () => {
    const adapter = adapterFor([
      ": keep-alive\n\n",
      frame("delta", deltaPayload("x")),
      frame("final", finalPayload("x")),
    ]);
    const final = await adapter.runTurn({ eventId: "e1", text: "hi" }, {});
    expect(final.content).toBe("x");
  });

  it("帧被 TCP 分片切断时仍能正确重组", async () => {
    const full = frame("delta", deltaPayload("分片")) + frame("final", finalPayload("分片"));
    const half = Math.floor(full.length / 2);
    const adapter = adapterFor([full.slice(0, half), full.slice(half)]);
    const final = await adapter.runTurn({ eventId: "e1", text: "hi" }, {});
    expect(final.content).toBe("分片");
  });

  it("支持 CRLF 分帧", async () => {
    const crlf = `event: final\r\ndata: ${JSON.stringify(finalPayload("crlf"))}\r\n\r\n`;
    const adapter = adapterFor([crlf]);
    const final = await adapter.runTurn({ eventId: "e1", text: "hi" }, {});
    expect(final.content).toBe("crlf");
  });

  it("单帧 JSON 损坏时跳过，不影响最终结果", async () => {
    const adapter = adapterFor([
      "event: delta\ndata: {broken json\n\n",
      frame("delta", deltaPayload("ok")),
      frame("final", finalPayload("ok")),
    ]);
    const final = await adapter.runTurn({ eventId: "e1", text: "hi" }, {});
    expect(final.content).toBe("ok");
  });

  it("必填字段缺失的帧被视为坏帧", async () => {
    const adapter = adapterFor([
      'event: delta\ndata: {"content":"没有 event_id"}\n\n',
      frame("final", finalPayload("正常")),
    ]);
    const final = await adapter.runTurn({ eventId: "e1", text: "hi" }, {});
    expect(final.content).toBe("正常");
  });

  it("error 帧抛 UpstreamRejectedError", async () => {
    const adapter = adapterFor([
      frame("meta", { event_id: "e1", session_id: "s1" }),
      frame("error", {
        error: { code: "ALL_PROVIDERS_FAILED", message: "x", retryable: false, request_id: "r" },
      }),
    ]);
    await expect(adapter.runTurn({ eventId: "e1", text: "hi" }, {})).rejects.toBeInstanceOf(
      UpstreamRejectedError,
    );
  });

  it("没有 final 时抛 UpstreamUnavailableError", async () => {
    const adapter = adapterFor([frame("delta", deltaPayload("半截"))]);
    await expect(adapter.runTurn({ eventId: "e1", text: "hi" }, {})).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
  });

  it("warning 后仍有 final 时正常返回（部分输出中断）", async () => {
    const adapter = adapterFor([
      frame("delta", deltaPayload("说到一半")),
      frame("warning", { code: "GENERATION_INTERRUPTED", message: "interrupted" }),
      frame("final", finalPayload("说到一半")),
    ]);
    const final = await adapter.runTurn({ eventId: "e1", text: "hi" }, {});
    expect(final.content).toBe("说到一半");
  });

  it("只收到 warning 没有 final 时抛错并说明中断", async () => {
    const adapter = adapterFor([
      frame("delta", deltaPayload("x")),
      frame("warning", { code: "GENERATION_INTERRUPTED" }),
    ]);
    await expect(adapter.runTurn({ eventId: "e1", text: "hi" }, {})).rejects.toThrow(/中断/);
  });

  it("未知事件名被忽略", async () => {
    const adapter = adapterFor([
      frame("future_event", { whatever: 1 }),
      frame("final", finalPayload("ok")),
    ]);
    const final = await adapter.runTurn({ eventId: "e1", text: "hi" }, {});
    expect(final.content).toBe("ok");
  });

  it("citations 帧被回调接收", async () => {
    const onCitations = vi.fn();
    const adapter = adapterFor([
      frame("citations", { citations: [{ url: "https://example.com" }] }),
      frame("final", finalPayload("ok")),
    ]);
    await adapter.runTurn({ eventId: "e1", text: "hi" }, { onCitations });
    expect(onCitations).toHaveBeenCalledTimes(1);
  });

  it("服务不可达时抛 UpstreamUnavailableError", async () => {
    const dead = new LLMAdapter("http://127.0.0.1:1");
    await expect(dead.runTurn({ eventId: "e1", text: "hi" }, {})).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
  });
});
