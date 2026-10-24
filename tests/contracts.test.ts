import { describe, expect, it } from "vitest";
import {
  ContractError,
  parseInputDegraded,
  parseInputEvent,
  parseLLMEvent,
  parseOutputEvent,
  parseUpstreamError,
} from "../src/contracts/index.js";
import { resolveAudioUrl } from "../src/upstream/adapters.js";

describe("parseInputEvent", () => {
  const valid = {
    event_id: "7e2c664e-420d-4993-91ae-5fac73a9c584",
    timestamp: "2026-10-24T09:38:37.008Z",
    modality: "text",
    content: "今天有点累，想找人说说话。",
    metadata: {
      asr_text: "",
      voiceprint_event: "none",
      model_capabilities: ["text", "image", "audio"],
    },
  };

  it("解析真实事件", () => {
    const event = parseInputEvent(valid);
    expect(event.event_id).toBe(valid.event_id);
    expect(event.modality).toBe("text");
    expect(event.metadata.voiceprint_event).toBe("none");
    expect(event.metadata.model_capabilities).toEqual(["text", "image", "audio"]);
  });

  it("识别唤醒事件", () => {
    const event = parseInputEvent({
      ...valid,
      metadata: { ...valid.metadata, voiceprint_event: "wakeup" },
    });
    expect(event.metadata.voiceprint_event).toBe("wakeup");
  });

  it("忽略未知字段（前向兼容）", () => {
    const event = parseInputEvent({ ...valid, future_field: { nested: true } });
    expect(event.event_id).toBe(valid.event_id);
  });

  it("缺失 event_id 时抛 ContractError", () => {
    expect(() => parseInputEvent({ ...valid, event_id: undefined })).toThrow(ContractError);
  });

  it("未知 modality 时抛 ContractError", () => {
    expect(() => parseInputEvent({ ...valid, modality: "hologram" })).toThrow(ContractError);
  });

  it("空 content 时抛 ContractError", () => {
    expect(() => parseInputEvent({ ...valid, content: "  " })).toThrow(ContractError);
  });

  it("metadata 缺失时给安全默认值", () => {
    const event = parseInputEvent({ ...valid, metadata: undefined });
    expect(event.metadata.voiceprint_event).toBe("none");
    expect(event.metadata.model_capabilities).toEqual([]);
  });
});

describe("parseInputDegraded", () => {
  it("读取降级响应头（大小写不敏感）", () => {
    const info = parseInputDegraded({
      "X-Dounai-Degraded": "true",
      "x-dounai-provider": "offline",
      "X-Dounai-Voiceprint-Checked": "false",
    });
    expect(info.degraded).toBe(true);
    expect(info.provider).toBe("offline");
    expect(info.voiceprintChecked).toBe(false);
  });

  it("无头时全部为默认值", () => {
    const info = parseInputDegraded({});
    expect(info.degraded).toBe(false);
    expect(info.provider).toBeNull();
  });
});

describe("parseLLMEvent", () => {
  it("解析 delta 帧", () => {
    const event = parseLLMEvent(
      {
        event_id: "e1",
        session_id: "s1",
        content: "增量",
        stream: true,
        tags: { emotion: "joy", type: "text", intent: "reply" },
      },
      true,
    );
    expect(event.stream).toBe(true);
    expect(event.tags.emotion).toBe("joy");
  });

  it("tags 缺失时回落到中性值", () => {
    const event = parseLLMEvent({ event_id: "e1", content: "x" }, false);
    expect(event.tags).toEqual({ emotion: "neutral", type: "text", intent: "reply" });
  });
});

describe("parseOutputEvent", () => {
  const base = {
    event_id: "40a5b15c-ad99-4b98-9b25-c0ff9aa9b4f3",
    text: "今天有点累，想找人说说话。",
    audio_ref: "/api/v1/audio/59837c2ece097a15ea8d9f26d0ce0cab.mp3",
    style: { emotion: "comfort", label: "安慰", speed: 0.92, tone: "温柔低缓" },
    speech_text: "朗读稿",
    audio_mime: "audio/mpeg",
    render: { type: "text", mode: "plain", blocks: [] },
    route: { intent: "reply", destination: "ui.voice_reply", synthesize: true },
    status: "synthesized",
    degraded: false,
    timings: { first_chunk_ms: 836.7, total_ms: 1163.1 },
  };

  it("解析合成成功事件", () => {
    const event = parseOutputEvent(base);
    expect(event.status).toBe("synthesized");
    expect(event.audio_ref).toBe(base.audio_ref);
    expect(event.route.synthesize).toBe(true);
    expect(event.timings.first_chunk_ms).toBe(836.7);
  });

  it("text_fallback 时 audio_ref 为 null", () => {
    const event = parseOutputEvent({
      ...base,
      status: "text_fallback",
      audio_ref: null,
      degraded: true,
    });
    expect(event.status).toBe("text_fallback");
    expect(event.audio_ref).toBeNull();
    expect(event.degraded).toBe(true);
  });

  it("未知 status 回落到 text_fallback（宁可无语音也不崩）", () => {
    const event = parseOutputEvent({ ...base, status: "quantum" });
    expect(event.status).toBe("text_fallback");
  });

  it("render.blocks 过滤非法项", () => {
    const event = parseOutputEvent({
      ...base,
      render: {
        type: "code",
        mode: "code",
        blocks: [{ kind: "code", content: "x = 1", language: "python" }, "bad", null],
      },
    });
    expect(event.render.blocks).toHaveLength(1);
    expect(event.render.blocks[0]?.language).toBe("python");
  });
});

describe("resolveAudioUrl", () => {
  it("拼接相对路径", () => {
    expect(resolveAudioUrl("http://127.0.0.1:8103", "/api/v1/audio/a.mp3")).toBe(
      "http://127.0.0.1:8103/api/v1/audio/a.mp3",
    );
  });

  it("基址带尾斜杠时不产生双斜杠", () => {
    expect(resolveAudioUrl("http://127.0.0.1:8103/", "/api/v1/audio/a.mp3")).toBe(
      "http://127.0.0.1:8103/api/v1/audio/a.mp3",
    );
  });

  it("绝对地址原样返回", () => {
    expect(resolveAudioUrl("http://x", "https://cdn/a.mp3")).toBe("https://cdn/a.mp3");
  });

  it("null 返回 null", () => {
    expect(resolveAudioUrl("http://x", null)).toBeNull();
  });
});

describe("parseUpstreamError", () => {
  it("解析标准错误体", () => {
    const error = parseUpstreamError({
      error: {
        code: "ALL_PROVIDERS_FAILED",
        message: "all failed",
        retryable: false,
        request_id: "r1",
      },
    });
    expect(error.code).toBe("ALL_PROVIDERS_FAILED");
    expect(error.retryable).toBe(false);
    expect(error.requestId).toBe("r1");
  });

  it("非标准结构也能给出 code", () => {
    const error = parseUpstreamError({ code: "X" });
    expect(error.code).toBe("X");
  });
});
