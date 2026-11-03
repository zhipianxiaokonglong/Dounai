/**
 * D-01 / D-02 回归测试：锁住两个 P0 缺陷的修复。
 *
 * 这两个缺陷的共同点是**静默失效**——没有报错、没有降级提示，
 * 所以必须用反向断言把"错误行为"钉死，否则以后很容易改回去。
 */

import { describe, expect, it, vi } from "vitest";

import { Orchestrator, type TurnSnapshot } from "../src/orchestrator/index.js";
import type {
  InputAdapter,
  LLMAdapter,
  OutputAdapter,
} from "../src/upstream/adapters.js";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

function makeInputEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "in-1",
    timestamp: "2026-11-03T00:00:00Z",
    modality: "text",
    content: "今天有点累",
    metadata: {
      asr_text: "",
      voiceprint_event: "none",
      model_capabilities: ["text"],
      asr_status: "not_applicable",
    },
    ...overrides,
  };
}

function makeOrchestrator(inputOverrides: Partial<Record<string, unknown>> = {}) {
  const snapshots: TurnSnapshot[] = [];
  const input = {
    submitText: vi.fn().mockResolvedValue({
      event: makeInputEvent(),
      degraded: { degraded: false, provider: "offline", model: null, voiceprintChecked: false, requestId: null },
    }),
    submitImage: vi.fn().mockResolvedValue({
      event: makeInputEvent({ modality: "image", content: "http://127.0.0.1:8101/v1/media/img" }),
      degraded: { degraded: false, provider: "offline", model: null, voiceprintChecked: false, requestId: null },
    }),
    submitAudio: vi.fn().mockResolvedValue({
      event: makeInputEvent({ modality: "audio", content: "http://127.0.0.1:8101/v1/media/aud" }),
      degraded: { degraded: false, provider: "offline", model: null, voiceprintChecked: false, requestId: null },
    }),
    ...inputOverrides,
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
  return { orchestrator, snapshots, input, llm, output };
}

/* ------------------------------------------------------------------ */
/* D-01：会话 ID 必须在顶层                                            */
/* ------------------------------------------------------------------ */

describe("D-01 会话标识", () => {
  it("session_id 出现在请求体顶层，而不是 metadata 里", async () => {
    const { orchestrator, llm } = makeOrchestrator();
    await orchestrator.submit({ kind: "text", text: "第一句" }, { sessionId: "11111111-1111-4111-8111-111111111111" });

    const call = vi.mocked(llm.runTurn).mock.calls[0];
    expect(call).toBeDefined();
    const sent = call![0];

    expect(sent.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    // 反向断言：不能退回到 metadata 里（那正是原缺陷）
    expect(Object.keys(sent)).not.toContain("metadata");
  });

  it("不传 sessionId 时也不会伪造一个空会话", async () => {
    const { orchestrator, llm } = makeOrchestrator();
    await orchestrator.submit({ kind: "text", text: "第一句" });

    const call = vi.mocked(llm.runTurn).mock.calls[0];
    const sent = call![0];
    expect(sent.sessionId).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* D-02：多模态分区                                                     */
/* ------------------------------------------------------------------ */

describe("D-02 内容分区", () => {
  it("图像以 data URI 分区发送，绝不发送回环 URL", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { orchestrator, llm } = makeOrchestrator();

    await orchestrator.submit({
      kind: "image",
      bytes,
      filename: "shot.png",
      mime: "image/png",
    });

    const call = vi.mocked(llm.runTurn).mock.calls[0];
    const sent = call![0];

    expect(sent.parts).toHaveLength(1);
    const part = sent.parts[0]!;
    expect(part.modality).toBe("image");
    expect(part.content.startsWith("data:image/png;base64,")).toBe(true);
    expect(part.metadata?.mime_type).toBe("image/png");
    expect(part.metadata?.filename).toBe("shot.png");

    // 反向断言：不能是事件体里那个回环 URL
    expect(part.content).not.toMatch(/127\.0\.0\.1/);
  });

  it("语音转写完成时用转写文本", async () => {
    const { orchestrator, llm } = makeOrchestrator({
      submitAudio: vi.fn().mockResolvedValue({
        event: makeInputEvent({
          modality: "audio",
          content: "http://127.0.0.1:8101/v1/media/aud",
          metadata: {
            asr_text: "我想请你帮个忙",
            voiceprint_event: "none",
            model_capabilities: ["audio"],
            asr_status: "completed",
          },
        }),
        degraded: { degraded: false, provider: "offline", model: null, voiceprintChecked: false, requestId: null },
      }),
    });

    await orchestrator.submit({ kind: "audio", bytes: new Uint8Array([1]), mime: "audio/webm" });

    const call = vi.mocked(llm.runTurn).mock.calls[0];
    const sent = call![0];
    expect(sent.parts).toEqual([{ modality: "text", content: "我想请你帮个忙" }]);
    expect(sent.parts[0]!.content).not.toMatch(/127\.0\.0\.1/);
  });

  it("语音转写不可用时不调用模型层，并给出明确提示", async () => {
    const { orchestrator, snapshots, llm } = makeOrchestrator({
      submitAudio: vi.fn().mockResolvedValue({
        event: makeInputEvent({
          modality: "audio",
          content: "http://127.0.0.1:8101/v1/media/aud",
          metadata: {
            asr_text: "",
            voiceprint_event: "none",
            model_capabilities: ["audio"],
            asr_status: "unavailable",
          },
        }),
        degraded: { degraded: true, provider: "offline", model: null, voiceprintChecked: false, requestId: null },
      }),
    });

    await orchestrator.submit({ kind: "audio", bytes: new Uint8Array([1]), mime: "audio/webm" });

    // 关键：绝不能把音频 URL 当文本发给模型层
    expect(vi.mocked(llm.runTurn)).not.toHaveBeenCalled();

    const last = snapshots[snapshots.length - 1];
    expect(last?.state).toBe("degraded");
    expect(last?.notice).toContain("语音转写不可用");
  });

  it("asr_status=completed 但文本为空时也按不可用处理", async () => {
    const { orchestrator, snapshots, llm } = makeOrchestrator({
      submitAudio: vi.fn().mockResolvedValue({
        event: makeInputEvent({
          modality: "audio",
          content: "http://127.0.0.1:8101/v1/media/aud",
          metadata: {
            asr_text: "   ",
            voiceprint_event: "none",
            model_capabilities: ["audio"],
            asr_status: "completed",
          },
        }),
        degraded: { degraded: false, provider: "offline", model: null, voiceprintChecked: false, requestId: null },
      }),
    });

    await orchestrator.submit({ kind: "audio", bytes: new Uint8Array([1]), mime: "audio/webm" });
    expect(vi.mocked(llm.runTurn)).not.toHaveBeenCalled();
    const last = snapshots[snapshots.length - 1];
    expect(last?.notice).toContain("语音转写不可用");
  });
});

/* ------------------------------------------------------------------ */
/* 兼容性：图像体积上限（对齐模型层 MAX_PART_CHARS）                     */
/* ------------------------------------------------------------------ */

describe("图像体积保护", () => {
  it("小图原图直发，不做任何重编码（保住字迹清晰）", async () => {
    const { orchestrator, llm } = makeOrchestrator();
    const small = new Uint8Array(1024); // 1KB
    await orchestrator.submit({ kind: "image", bytes: small, filename: "s.png", mime: "image/png" });

    const sent = vi.mocked(llm.runTurn).mock.calls[0]![0];
    const part = sent.parts[0]!;
    expect(part.content.startsWith("data:image/png;base64,")).toBe(true);
    // 直发的含义：base64 长度应恰好对应原始字节数（没有降采样/重编码）
    const base64Len = part.content.length - "data:image/png;base64,".length;
    expect(base64Len).toBe(Math.ceil(small.byteLength / 3) * 4);
  });

  it("超过上限的图不发出去，并明确说明原因与上限", async () => {
    const { orchestrator, snapshots, llm } = makeOrchestrator();
    // 9MB 二进制 → base64 约 12MB 字符，必然超过 10,000,000
    const big = new Uint8Array(9 * 1024 * 1024);
    await orchestrator.submit({ kind: "image", bytes: big, filename: "big.png", mime: "image/png" });

    expect(vi.mocked(llm.runTurn)).not.toHaveBeenCalled();
    const notice = snapshots[snapshots.length - 1]?.notice ?? "";
    expect(notice).toContain("图片太大");
    expect(notice).toContain("MB");
    // 必须说清"没自动压缩"的原因，避免用户以为功能坏了
    expect(notice).toContain("没有自动压缩");
  });

  it("刚好低于上限的图可以发出（边界不误杀）", async () => {
    const { orchestrator, llm } = makeOrchestrator();
    // 取 7MB：base64 约 9.8M 字符，低于 10M 上限
    const size = 7 * 1024 * 1024;
    const ok = new Uint8Array(size);
    await orchestrator.submit({ kind: "image", bytes: ok, filename: "edge.png", mime: "image/png" });

    const calls = vi.mocked(llm.runTurn).mock.calls;
    expect(calls.length).toBe(1);
    const part = calls[0]![0].parts[0]!;
    expect(part.content.length).toBeLessThanOrEqual(10_000_000);
  });
});

/* ------------------------------------------------------------------ */
/* 兼容性：asr_status 四值语义                                          */
/* ------------------------------------------------------------------ */

describe("asr_status 语义区分（对齐输入层 4 值枚举）", () => {
  function audioCase(status: string, text = "") {
    return makeOrchestrator({
      submitAudio: vi.fn().mockResolvedValue({
        event: makeInputEvent({
          modality: "audio",
          content: "http://127.0.0.1:8101/v1/media/aud",
          metadata: {
            asr_text: text,
            voiceprint_event: "none",
            model_capabilities: ["audio"],
            asr_status: status,
          },
        }),
        degraded: { degraded: status !== "completed", provider: "offline", model: null, voiceprintChecked: false, requestId: null },
      }),
    });
  }

  it("empty（按了录音但没说话）应提示再说一次，而不是让用户去配厂商", async () => {
    const { orchestrator, snapshots, llm } = audioCase("empty");
    await orchestrator.submit({ kind: "audio", bytes: new Uint8Array([1]), mime: "audio/webm" });

    expect(vi.mocked(llm.runTurn)).not.toHaveBeenCalled();
    const notice = snapshots[snapshots.length - 1]?.notice ?? "";
    expect(notice).toContain("没有听到语音内容");
    // 关键反向断言：不能把"没说话"说成"转写能力不可用"
    expect(notice).not.toContain("配置带转写能力的厂商");
  });

  it("unavailable（转写能力缺失）才提示去配置厂商", async () => {
    const { orchestrator, snapshots, llm } = audioCase("unavailable");
    await orchestrator.submit({ kind: "audio", bytes: new Uint8Array([1]), mime: "audio/webm" });

    expect(vi.mocked(llm.runTurn)).not.toHaveBeenCalled();
    const notice = snapshots[snapshots.length - 1]?.notice ?? "";
    expect(notice).toContain("语音转写不可用");
    expect(notice).toContain("配置带转写能力的厂商");
  });

  it("completed 但文本为空按 empty 处理（不冒充可用文本）", async () => {
    const { orchestrator, snapshots, llm } = audioCase("completed", "   ");
    await orchestrator.submit({ kind: "audio", bytes: new Uint8Array([1]), mime: "audio/webm" });

    expect(vi.mocked(llm.runTurn)).not.toHaveBeenCalled();
    const notice = snapshots[snapshots.length - 1]?.notice ?? "";
    expect(notice.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* D-04：收起面板不清数据                                               */
/* ------------------------------------------------------------------ */

describe("D-04 收起与清空语义", () => {
  it("reset() 清空对话且保留健康状态", async () => {
    const { orchestrator, snapshots } = makeOrchestrator();
    await orchestrator.submit({ kind: "text", text: "第一句" });

    const before = snapshots[snapshots.length - 1];
    orchestrator.reset();
    const last = snapshots[snapshots.length - 1];
    expect(last?.text).toBe("");
    expect(last?.state).toBe("default");
    // health 不应被 reset 抹成"全部可用"——它保留的是上一次探活结果
    expect(last?.health).toEqual(before?.health);
  });
});
