/**
 * 第4步测试：模型清解析 + 发图能力检查。
 *
 * 重点验证"模型不支持图片时不发请求"——这是避免用户看到
 * 上游降级成 "[Image attachment omitted]"（答非所问）的关键。
 */

import { describe, expect, it, vi } from "vitest";

import { parseModels } from "../src/contracts/index.js";
import { Orchestrator, type TurnSnapshot } from "../src/orchestrator/index.js";
import type {
  InputAdapter,
  LLMAdapter,
  OutputAdapter,
} from "../src/upstream/adapters.js";

function makeInputEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "in-1",
    timestamp: "2026-11-03T00:00:00Z",
    modality: "image",
    content: "http://127.0.0.1:8101/v1/media/img",
    metadata: {
      asr_text: "",
      voiceprint_event: "none",
      model_capabilities: ["image"],
      asr_status: "not_applicable",
    },
    ...overrides,
  };
}

function makeOrchestrator() {
  const snapshots: TurnSnapshot[] = [];
  const okDegraded = {
    degraded: false,
    provider: "offline",
    model: null,
    voiceprintChecked: false,
    requestId: null,
  };

  const input = {
    submitText: vi.fn(),
    submitImage: vi.fn().mockResolvedValue({ event: makeInputEvent(), degraded: okDegraded }),
    submitAudio: vi.fn(),
  } as unknown as InputAdapter;

  const llm = {
    runTurn: vi.fn().mockResolvedValue({
      event_id: "out-1",
      session_id: "s-1",
      content: "模型回复",
      stream: false,
      tags: { emotion: "neutral", type: "text", intent: "reply" },
    }),
    probe: vi.fn().mockResolvedValue(true),
  } as unknown as LLMAdapter;

  const output = {
    synthesize: vi.fn().mockResolvedValue({
      event_id: "out-1",
      session_id: "s-1",
      status: "text_fallback",
      degraded: true,
      audio_ref: null,
    }),
    audioUrl: vi.fn().mockReturnValue(null),
    probe: vi.fn().mockResolvedValue(true),
  } as unknown as OutputAdapter;

  const orchestrator = new Orchestrator(
    { input, llm, output },
    { onSnapshot: (s) => snapshots.push(s) },
  );
  return { orchestrator, snapshots, input, llm };
}

describe("parseModels", () => {
  it("解析能力、可用性与验证状态", () => {
    const raw = {
      models: [
        {
          id: "openai:gpt-4o",
          label: "GPT-4o",
          providerKind: "builtin",
          providerName: "OpenAI",
          model: "gpt-4o",
          capabilities: { inputModalities: ["text", "image"], contextWindow: 128000 },
          available: false,
          unavailableReason: "missing_api_key",
          verification: "unverified",
        },
        {
          id: "ollama:llama3",
          providerKind: "custom",
          providerName: "Ollama",
          capabilities: { inputModalities: ["text"] },
          available: true,
          verification: "ok",
        },
      ],
    };
    const models = parseModels(raw);
    expect(models).toHaveLength(2);
    expect(models[0]!.inputModalities).toEqual(["text", "image"]);
    expect(models[0]!.available).toBe(false);
    expect(models[0]!.unavailableReason).toBe("missing_api_key");
    // label 缺省时用 id
    expect(models[1]!.label).toBe("ollama:llama3");
    expect(models[1]!.providerKind).toBe("custom");
  });

  it("结构异常时抛 ContractError", () => {
    expect(() => parseModels({})).toThrow();
    expect(() => parseModels({ models: "not-array" })).toThrow();
  });
});

describe("发图前能力检查", () => {
  it("模型不支持图片时不发请求，并说明原因", async () => {
    const { orchestrator, snapshots, input, llm } = makeOrchestrator();

    await orchestrator.submit({
      kind: "image",
      bytes: new Uint8Array([1, 2, 3]),
      filename: "a.png",
      mime: "image/png",
      modelSupportsImage: false,
    });

    // 关键：既不该调输入层上传，也不该调模型层
    expect(vi.mocked(input.submitImage)).not.toHaveBeenCalled();
    expect(vi.mocked(llm.runTurn)).not.toHaveBeenCalled();

    const last = snapshots[snapshots.length - 1];
    expect(last?.state).toBe("degraded");
    expect(last?.notice).toContain("当前模型不支持图片");
    expect(last?.notice).toContain("可看图");
  });

  it("模型支持图片时正常发送（走 data URI 分区）", async () => {
    const { orchestrator, input, llm } = makeOrchestrator();

    await orchestrator.submit({
      kind: "image",
      bytes: new Uint8Array([1, 2, 3]),
      filename: "a.png",
      mime: "image/png",
      modelSupportsImage: true,
    });

    expect(vi.mocked(input.submitImage)).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(llm.runTurn).mock.calls[0]![0];
    expect(sent.parts[0]!.modality).toBe("image");
    expect(sent.parts[0]!.content.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("能力未知（未传）时按原逻辑发送，交给上游判定", async () => {
    const { orchestrator, input } = makeOrchestrator();

    await orchestrator.submit({
      kind: "image",
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
    });

    expect(vi.mocked(input.submitImage)).toHaveBeenCalledTimes(1);
  });
});
