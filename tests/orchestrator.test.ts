/**
 * 编排器与降级路径测试。
 *
 * 覆盖需求中的验收点：
 *  - 某模块不可用时 UI 优雅降级，不崩溃；
 *  - output 失败不影响文本显示；
 *  - final 的标签覆盖 delta 的临时标签；
 *  - 音画同步：说话态结束以音频结束为准。
 */

import { describe, expect, it, vi } from "vitest";
import { Orchestrator, type TurnSnapshot } from "../src/orchestrator/index.js";
import type { InputAdapter, LLMAdapter, OutputAdapter } from "../src/upstream/adapters.js";
import {
  TimeoutError,
  UpstreamRejectedError,
  UpstreamUnavailableError,
} from "../src/upstream/adapters.js";
import type { InputEvent, LLMEvent, OutputEvent } from "../src/contracts/index.js";

function makeInputEvent(overrides: Partial<InputEvent> = {}): InputEvent {
  return {
    event_id: "in-1",
    timestamp: "2026-10-24T00:00:00Z",
    modality: "text",
    content: "今天有点累",
    metadata: { asr_text: "", voiceprint_event: "none", model_capabilities: ["text"] },
    ...overrides,
  };
}

function makeLLMEvent(overrides: Partial<LLMEvent> = {}): LLMEvent {
  return {
    event_id: "out-1",
    session_id: "sess-1",
    content: "我在呢，慢慢说。",
    stream: false,
    tags: { emotion: "comfort", type: "text", intent: "reply" },
    ...overrides,
  };
}

function makeOutputEvent(overrides: Partial<OutputEvent> = {}): OutputEvent {
  return {
    event_id: "out-1",
    text: "我在呢，慢慢说。",
    audio_ref: "/api/v1/audio/x.mp3",
    style: {
      emotion: "comfort",
      label: "安慰",
      speed: 0.92,
      tone: "温柔",
      description: "",
      pitch_semitones: -1,
      source_tag: "comfort",
      mapping_hit: true,
    },
    speech_text: "我在呢，慢慢说。",
    audio_mime: "audio/mpeg",
    audio_format: "mp3",
    render: { type: "text", mode: "plain", language: null, blocks: [], copyable: false },
    route: { intent: "reply", destination: "ui.voice_reply", synthesize: true, reason: "" },
    provider: "edge",
    status: "synthesized",
    degraded: false,
    timings: { first_chunk_ms: 100, total_ms: 200 },
    ...overrides,
  };
}

interface StubOptions {
  input?: Partial<InputAdapter>;
  llm?: Partial<LLMAdapter>;
  output?: Partial<OutputAdapter>;
}

function makeOrchestrator(options: StubOptions = {}) {
  const snapshots: TurnSnapshot[] = [];

  const input = {
    probe: vi.fn().mockResolvedValue(true),
    submitText: vi.fn().mockResolvedValue({
      event: makeInputEvent(),
      degraded: { degraded: false, provider: "offline", model: null, voiceprintChecked: false, requestId: null },
    }),
    ...options.input,
  } as unknown as InputAdapter;

  const llm = {
    probe: vi.fn().mockResolvedValue(true),
    runTurn: vi.fn().mockResolvedValue(makeLLMEvent()),
    ...options.llm,
  } as unknown as LLMAdapter;

  const output = {
    probe: vi.fn().mockResolvedValue(true),
    synthesize: vi.fn().mockResolvedValue(makeOutputEvent()),
    audioUrl: (ref: string | null) => (ref ? `http://127.0.0.1:8103${ref}` : null),
    ...options.output,
  } as unknown as OutputAdapter;

  const orchestrator = new Orchestrator(
    { input, llm, output },
    { onSnapshot: (snapshot) => snapshots.push(snapshot) },
  );

  return { orchestrator, snapshots, input, llm, output };
}

describe("Orchestrator 正常链路", () => {
  it("完整回合产出文本与音频地址", async () => {
    const { orchestrator } = makeOrchestrator();
    const snapshot = await orchestrator.submit("今天有点累");

    expect(snapshot.text).toBe("我在呢，慢慢说。");
    expect(snapshot.audioUrl).toBe("http://127.0.0.1:8103/api/v1/audio/x.mp3");
    expect(snapshot.emotion).toBe("comfort");
    expect(snapshot.state).toBe("talking");
    expect(snapshot.notice).toBeNull();
  });

  it("把 input 的 event_id 作为下游幂等键", async () => {
    const { orchestrator, llm } = makeOrchestrator();
    await orchestrator.submit("hi");
    expect(llm.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "in-1" }),
      expect.anything(),
    );
  });

  it("用 final 的完整文本调用 output（而非 delta）", async () => {
    const { orchestrator, output } = makeOrchestrator();
    await orchestrator.submit("hi");
    expect(output.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ content: "我在呢，慢慢说。", emotion: "comfort" }),
    );
  });

  it("final 的标签覆盖 delta 的临时标签", async () => {
    const { orchestrator } = makeOrchestrator({
      llm: {
        runTurn: vi.fn().mockImplementation(async (_req, callbacks) => {
          callbacks.onDelta?.(
            makeLLMEvent({ stream: true, tags: { emotion: "neutral", type: "text", intent: "reply" } }),
          );
          const final = makeLLMEvent({ tags: { emotion: "gratitude", type: "text", intent: "reply" } });
          callbacks.onFinal?.(final);
          return final;
        }),
      },
    });
    const snapshot = await orchestrator.submit("谢谢");
    expect(snapshot.emotion).toBe("gratitude");
  });

  it("同一 final 不重复合成（幂等）", async () => {
    const { orchestrator, output } = makeOrchestrator();
    await orchestrator.submit("a");
    // 第二次提交返回同一 event_id 的 final
    await orchestrator.submit("b");
    // 第一次已处理，第二次因 handledFinals 命中而跳过 output
    expect(output.synthesize).toHaveBeenCalledTimes(1);
  });
});

describe("降级：input 不可用", () => {
  it("进入 degraded 并给出可读提示，不抛异常", async () => {
    const { orchestrator } = makeOrchestrator({
      input: {
        submitText: vi
          .fn()
          .mockRejectedValue(new UpstreamUnavailableError("input", "ECONNREFUSED")),
      },
    });
    const snapshot = await orchestrator.submit("hi");
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.notice).toContain("输入服务未连接");
    expect(snapshot.health.input).toBe(false);
  });

  it("input 超时也降级", async () => {
    const { orchestrator } = makeOrchestrator({
      input: {
        submitText: vi.fn().mockRejectedValue(new TimeoutError("input", "submitText", 15000)),
      },
    });
    const snapshot = await orchestrator.submit("hi");
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.notice).toContain("超时");
  });
});

describe("降级：LLM 不可用", () => {
  it("保留已流出文本，不崩溃", async () => {
    const { orchestrator } = makeOrchestrator({
      llm: {
        runTurn: vi.fn().mockImplementation(async (_req, callbacks) => {
          callbacks.onDelta?.(makeLLMEvent({ stream: true, content: "说到一半" }));
          throw new UpstreamUnavailableError("omninexus", "ECONNRESET");
        }),
      },
    });
    const snapshot = await orchestrator.submit("hi");
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.text).toBe("说到一半");
    expect(snapshot.notice).toContain("模型服务未连接");
  });

  it("无可用模型时给出配置提示", async () => {
    const { orchestrator } = makeOrchestrator({
      llm: {
        runTurn: vi.fn().mockRejectedValue(
          new UpstreamRejectedError("omninexus", {
            code: "NO_PROVIDER_AVAILABLE",
            message: "",
            retryable: false,
            requestId: null,
          }),
        ),
      },
    });
    const snapshot = await orchestrator.submit("hi");
    expect(snapshot.notice).toContain("还没有可用的模型");
  });
});

describe("降级：output 不可用", () => {
  it("文本照常显示，只是没有音频", async () => {
    const { orchestrator } = makeOrchestrator({
      output: {
        synthesize: vi.fn().mockRejectedValue(new UpstreamUnavailableError("output", "down")),
      },
    });
    const snapshot = await orchestrator.submit("hi");
    expect(snapshot.text).toBe("我在呢，慢慢说。");
    expect(snapshot.audioUrl).toBeNull();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.notice).toContain("语音服务未连接");
  });

  it("text_fallback 状态视为降级但保留文本", async () => {
    const { orchestrator } = makeOrchestrator({
      output: {
        synthesize: vi.fn().mockResolvedValue(
          makeOutputEvent({ status: "text_fallback", audio_ref: null, degraded: true }),
        ),
      },
    });
    const snapshot = await orchestrator.submit("hi");
    expect(snapshot.text).toBe("我在呢，慢慢说。");
    expect(snapshot.audioUrl).toBeNull();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.notice).toContain("只显示文字");
  });
});

describe("音画同步", () => {
  it("有音频时，talking 态只在音频结束后才回到 default", async () => {
    const { orchestrator } = makeOrchestrator();
    const snapshot = await orchestrator.submit("hi");
    expect(snapshot.state).toBe("talking");
    expect(snapshot.audioUrl).not.toBeNull();

    orchestrator.notifyAudioEnded();
    expect(orchestrator.getSnapshot().state).toBe("default");
  });

  it("无音频时，文本渲染完即可回到 default", async () => {
    const { orchestrator } = makeOrchestrator({
      output: {
        synthesize: vi.fn().mockResolvedValue(
          makeOutputEvent({ status: "text_fallback", audio_ref: null, degraded: true }),
        ),
      },
    });
    await orchestrator.submit("hi");
    orchestrator.notifyTextSettled();
    expect(orchestrator.getSnapshot().state).toBe("default");
  });

  it("音频结束事件在 default 态下不产生副作用", () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.notifyAudioEnded();
    expect(orchestrator.getSnapshot().state).toBe("default");
  });
});

describe("探活", () => {
  it("三个模块全通时 health 全为 true", async () => {
    const { orchestrator } = makeOrchestrator();
    const health = await orchestrator.probe();
    expect(health).toEqual({ input: true, llm: true, output: true });
  });

  it("output 不可用不影响 input/llm 判定", async () => {
    const { orchestrator } = makeOrchestrator({
      output: { probe: vi.fn().mockResolvedValue(false) },
    });
    const health = await orchestrator.probe();
    expect(health).toEqual({ input: true, llm: true, output: false });
    expect(orchestrator.getSnapshot().state).not.toBe("degraded");
  });

  it("input 不可用时进入 degraded", async () => {
    const { orchestrator } = makeOrchestrator({
      input: { probe: vi.fn().mockResolvedValue(false) },
    });
    const health = await orchestrator.probe();
    expect(health.input).toBe(false);
    expect(orchestrator.getSnapshot().state).toBe("degraded");
  });
});
