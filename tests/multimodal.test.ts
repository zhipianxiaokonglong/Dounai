/**
 * 多模态输入与提示词接口测试。
 *
 * 结构图要求 UI 提供文字 / 图像 / 语音三路入口，并且提示词操作要「供 UI 调用」。
 * 这里用本地 HTTP 服务器验证真实的上传报文与请求体，而不是只断言函数被调用。
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InputAdapter, LLMAdapter } from "../src/upstream/adapters.js";
import { buildMultipart, guessExtension } from "../src/upstream/multipart.js";

let server: Server;
let base = "";

interface Captured {
  path: string;
  contentType: string;
  body: Buffer;
}

let captured: Captured | null = null;
/** 服务器返回的固定事件体 */
let reply: unknown = null;
let status = 201;
let headers: Record<string, string> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      captured = {
        path: req.url ?? "",
        contentType: String(req.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks),
      };
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(reply));
    });
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
  captured = null;
  status = 201;
  headers = {};
  reply = {
    event_id: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-10-25T00:00:00.000Z",
    modality: "image",
    content: "http://127.0.0.1:8101/v1/media/abc",
    metadata: { asr_text: "", voiceprint_event: "none", model_capabilities: ["text"] },
  };
});

describe("multipart 构造", () => {
  it("生成合法的 multipart 边界与文件段", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const form = buildMultipart(
      { field: "file", filename: "a.png", mime: "image/png", bytes },
      { session_id: "s1", source: "dounai-desktop" },
    );

    expect(form.contentType).toMatch(/^multipart\/form-data; boundary=----dounai/);
    const text = new TextDecoder().decode(form.bytes);
    expect(text).toContain('name="file"');
    expect(text).toContain('filename="a.png"');
    expect(text).toContain("Content-Type: image/png");
    expect(text).toContain('name="session_id"');
    expect(text).toContain("s1");
    // 结尾必须是闭合边界
    expect(text.trimEnd().endsWith("--")).toBe(true);
  });

  it("undefined 字段被跳过，不产生空段", () => {
    const form = buildMultipart(
      { field: "file", filename: "v.webm", mime: "audio/webm", bytes: new Uint8Array([1]) },
      { session_id: undefined, language: "zh" },
    );
    const text = new TextDecoder().decode(form.bytes);
    expect(text).not.toContain('name="session_id"');
    expect(text).toContain('name="language"');
  });

  it("按 MIME 推断扩展名", () => {
    expect(guessExtension("", "image/jpeg")).toBe("jpg");
    expect(guessExtension("", "audio/webm")).toBe("webm");
    expect(guessExtension("photo.PNG", "image/png")).toBe("png");
    expect(guessExtension("", "application/unknown")).toBe("bin");
  });
});

describe("InputAdapter 图像输入", () => {
  it("POST 到 /v1/inputs/image 且带 multipart 文件段", async () => {
    const adapter = new InputAdapter(base);
    const result = await adapter.submitImage({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
      filename: "cup.png",
      mime: "image/png",
    });

    expect(captured?.path).toBe("/v1/inputs/image");
    expect(captured?.contentType).toMatch(/^multipart\/form-data/);
    const text = captured ? new TextDecoder().decode(captured.body) : "";
    expect(text).toContain('filename="cup.png"');

    // 事件按契约解析，图像事件 content 是受控媒体 URL
    expect(result.event.modality).toBe("image");
    expect(result.event.content).toContain("/v1/media/");
  });

  it("缺少文件名时按 MIME 补一个", async () => {
    const adapter = new InputAdapter(base);
    await adapter.submitImage({ bytes: new Uint8Array([1]), mime: "image/webp" });
    const text = captured ? new TextDecoder().decode(captured.body) : "";
    expect(text).toContain('filename="paste.webp"');
  });
});

describe("InputAdapter 语音输入", () => {
  it("POST 到 /v1/inputs/audio 并带上 language", async () => {
    reply = {
      event_id: "22222222-2222-4222-8222-222222222222",
      timestamp: "2026-10-25T00:00:00.000Z",
      modality: "audio",
      content: "http://127.0.0.1:8101/v1/media/voice",
      metadata: {
        asr_text: "今天有点累",
        voiceprint_event: "wakeup",
        model_capabilities: ["text", "audio"],
      },
    };

    const adapter = new InputAdapter(base);
    const result = await adapter.submitAudio({
      bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      filename: "voice.webm",
      mime: "audio/webm",
      language: "zh",
    });

    expect(captured?.path).toBe("/v1/inputs/audio");
    const text = captured ? new TextDecoder().decode(captured.body) : "";
    expect(text).toContain('name="language"');
    expect(text).toContain("zh");

    // 声纹唤醒必须能从事件里读出来——这是唤醒态的唯一上游来源
    expect(result.event.metadata.voiceprint_event).toBe("wakeup");
    expect(result.event.metadata.asr_text).toBe("今天有点累");
  });

  it("转写失败时通过响应头传达降级，而不是塞进事件体", async () => {
    headers = { "X-Dounai-Degraded": "true" };
    reply = {
      event_id: "33333333-3333-4333-8333-333333333333",
      timestamp: "2026-10-25T00:00:00.000Z",
      modality: "audio",
      content: "http://127.0.0.1:8101/v1/media/voice",
      metadata: { asr_text: "", voiceprint_event: "none", model_capabilities: [] },
    };

    const adapter = new InputAdapter(base);
    const result = await adapter.submitAudio({ bytes: new Uint8Array([1]) });

    expect(result.degraded.degraded).toBe(true);
    expect(result.event.metadata.asr_text).toBe("");
  });

  it("超限时把上游 413 转成 UpstreamRejectedError", async () => {
    status = 413;
    reply = { error: { code: "PAYLOAD_TOO_LARGE", message: "too big", retryable: false } };

    const adapter = new InputAdapter(base);
    await expect(adapter.submitImage({ bytes: new Uint8Array([1]) })).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
  });
});

describe("LLMAdapter 提示词接口", () => {
  it("解析 /v1/prompts/profiles 列表", async () => {
    status = 200;
    reply = {
      profiles: [
        {
          id: "default",
          name: "default",
          description: "内置空白人格",
          builtin: 1,
          active_version: 1,
        },
        { id: "warm", name: "温柔", description: "", builtin: 0, active_version: 3 },
      ],
    };

    const adapter = new LLMAdapter(base);
    const profiles = await adapter.listPromptProfiles();

    expect(captured?.path).toBe("/v1/prompts/profiles");
    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.builtin).toBe(true);
    expect(profiles[1]?.activeVersion).toBe(3);
  });

  it("接口失败时返回空数组而不是抛错（不影响对话）", async () => {
    status = 500;
    reply = { error: { code: "INTERNAL_ERROR" } };
    const adapter = new LLMAdapter(base);
    await expect(adapter.listPromptProfiles()).resolves.toEqual([]);
  });

  it("不可达时也返回空数组", async () => {
    const dead = new LLMAdapter("http://127.0.0.1:1");
    await expect(dead.listPromptProfiles()).resolves.toEqual([]);
  });
});
