/**
 * 悬浮窗跟随模型层会话设置（联网搜索）。
 *
 * 关键约束：悬浮窗没有自己的搜索开关。每轮提交前读一次
 * `GET /v1/sessions/{id}/settings`，把 `web_search` 放进
 * `metadata.web_search`；读不到时**不传**，让模型层按会话默认值处理。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LLMAdapter } from "../src/upstream/adapters.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SETTINGS_PATH = `/v1/sessions/${SESSION_ID}/settings`;

let server: Server;
let base = "";
let settingsStatus = 200;
let settingsBody: Record<string, unknown> = {};
let settingsReads = 0;
let posted: Record<string, unknown> | null = null;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    if (req.method === "GET" && req.url === SETTINGS_PATH) {
      settingsReads += 1;
      res.writeHead(settingsStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(settingsBody));
      return;
    }

    if (req.method === "POST" && req.url === "/v1/events") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        posted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `event: final\ndata: ${JSON.stringify({
            event_id: "22222222-2222-4222-8222-222222222222",
            session_id: SESSION_ID,
            content: "ok",
            stream: false,
            tags: { emotion: "neutral", type: "text", intent: "reply" },
          })}\n\n`,
        );
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  settingsStatus = 200;
  settingsBody = { session_id: SESSION_ID, web_search: false };
  settingsReads = 0;
  posted = null;
});

async function run(webSearch?: boolean): Promise<Record<string, unknown>> {
  const adapter = new LLMAdapter(base);
  await adapter.runTurn(
    {
      eventId: "33333333-3333-4333-8333-333333333333",
      parts: [{ modality: "text", content: "最近的科技新闻" }],
      sessionId: SESSION_ID,
      ...(webSearch !== undefined ? { webSearch } : {}),
    },
    {},
  );
  expect(posted).not.toBeNull();
  return posted as Record<string, unknown>;
}

function metadataOf(body: Record<string, unknown>): Record<string, unknown> {
  const metadata = body.metadata;
  expect(metadata).toBeTypeOf("object");
  return metadata as Record<string, unknown>;
}

describe("悬浮窗跟随会话搜索设置", () => {
  it("会话开启搜索时，请求体带 web_search=true", async () => {
    settingsBody = { session_id: SESSION_ID, web_search: true };
    const body = await run();
    expect(metadataOf(body).web_search).toBe(true);
    expect(settingsReads).toBe(1);
  });

  it("会话关闭搜索时，请求体带 web_search=false", async () => {
    settingsBody = { session_id: SESSION_ID, web_search: false };
    const body = await run();
    expect(metadataOf(body).web_search).toBe(false);
  });

  it("读不到会话设置时不覆盖，交给模型层按会话默认值处理", async () => {
    settingsStatus = 404;
    const body = await run();
    expect(metadataOf(body)).not.toHaveProperty("web_search");
  });

  it("显式传入时不再读取会话设置", async () => {
    const body = await run(true);
    expect(metadataOf(body).web_search).toBe(true);
    expect(settingsReads).toBe(0);
  });
});
