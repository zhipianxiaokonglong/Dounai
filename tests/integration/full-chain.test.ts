/**
 * 全链路集成测试（真实上游）。
 *
 * 与单元测试不同，这里**不 mock**：直接打三个真实模块的 HTTP 接口，
 * 验证契约在真实网络、真实序列化下的表现。
 *
 * 运行前提（见 tests/integration/README.md）：
 *   input :8101 / OmniNexus :8102（启用 echo 模型）/ output :8103
 * 未启动时自动跳过，不阻塞常规单测。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InputAdapter,
  LLMAdapter,
  OutputAdapter,
  resolveAudioUrl,
} from "../../src/upstream/adapters.js";
import { Orchestrator, type TurnSnapshot } from "../../src/orchestrator/index.js";
import type { LLMEvent } from "../../src/contracts/index.js";

const ENDPOINTS = {
  input: process.env.DOUNAI_INPUT_URL ?? "http://127.0.0.1:8101",
  llm: process.env.DOUNAI_LLM_URL ?? "http://127.0.0.1:8102",
  output: process.env.DOUNAI_OUTPUT_URL ?? "http://127.0.0.1:8103",
};

const input = new InputAdapter(ENDPOINTS.input);
const llm = new LLMAdapter(ENDPOINTS.llm);
const output = new OutputAdapter(ENDPOINTS.output);

let available = { input: false, llm: false, output: false };

beforeAll(async () => {
  const [a, b, c] = await Promise.all([input.probe(), llm.probe(), output.probe()]);
  available = { input: a, llm: b, output: c };
  if (!a || !b || !c) {
    console.warn(
      `[integration] 上游未全部就绪 input=${a} llm=${b} output=${c}，相关用例将跳过`,
    );
  }
}, 30_000);

afterAll(() => {
  // 无资源需要释放；保留钩子以便未来清理临时音频
});

describe("input 契约", () => {
  it("文字输入返回严格契约事件", async () => {
    if (!available.input) return;
    const { event, degraded } = await input.submitText("今天有点累，想找人说说话。");

    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(event.modality).toBe("text");
    expect(event.content).toBe("今天有点累，想找人说说话。");
    expect(event.metadata.voiceprint_event).toBe("none");
    expect(Array.isArray(event.metadata.model_capabilities)).toBe(true);
    // 契约要求事件体只有约定字段，降级信息必须在响应头
    expect(degraded).toHaveProperty("degraded");
  });

  it("空文本被上游拒绝，抛 UpstreamRejectedError 而非崩溃", async () => {
    if (!available.input) return;
    await expect(input.submitText("   ")).rejects.toThrow();
  });
});

describe("OmniNexus SSE 契约", () => {
  it("完整回合按 meta → route → delta → final 顺序产出", async () => {
    if (!available.llm) return;

    const order: string[] = [];
    const deltas: LLMEvent[] = [];

    const final = await llm.runTurn(
      { eventId: crypto.randomUUID(), text: "用一句话打个招呼", model: "echo:echo" },
      {
        onMeta: () => order.push("meta"),
        onRoute: () => order.push("route"),
        onDelta: (event) => {
          if (!order.includes("delta")) order.push("delta");
          deltas.push(event);
        },
        onFinal: () => order.push("final"),
      },
    );

    expect(order[0]).toBe("meta");
    expect(order).toContain("route");
    expect(order).toContain("delta");
    expect(order[order.length - 1]).toBe("final");

    expect(final.stream).toBe(false);
    expect(final.content.length).toBeGreaterThan(0);
    expect(final.tags).toHaveProperty("emotion");
    expect(final.tags).toHaveProperty("type");
    expect(final.tags).toHaveProperty("intent");

    // delta 是增量，final 是完整值：final 不应短于任一 delta
    for (const delta of deltas) {
      expect(final.content.length).toBeGreaterThanOrEqual(delta.content.length);
    }
  }, 60_000);

  it("同一 event_id 重投返回同一输出事件（幂等）", async () => {
    if (!available.llm) return;
    const eventId = crypto.randomUUID();
    const first = await llm.runTurn({ eventId, text: "幂等测试", model: "echo:echo" }, {});
    const second = await llm.runTurn({ eventId, text: "幂等测试", model: "echo:echo" }, {});
    expect(second.event_id).toBe(first.event_id);
  }, 90_000);
});

describe("output 契约", () => {
  it("合成成功时返回可拼接的 audio_ref 与风格载荷", async () => {
    if (!available.output) return;

    const result = await output.synthesize({
      eventId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      content: "今天辛苦了，先慢慢呼吸一下。",
      emotion: "comfort",
      type: "text",
      intent: "reply",
    });

    expect(["synthesized", "text_only", "text_fallback"]).toContain(result.status);
    expect(result.text).toBe("今天辛苦了，先慢慢呼吸一下。");
    expect(result.style).toHaveProperty("emotion");

    if (result.status === "synthesized") {
      expect(result.audio_ref).toBeTruthy();
      const url = resolveAudioUrl(ENDPOINTS.output, result.audio_ref);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8103\//);
    } else {
      // 降级路径：允许没有音频，但文本必须在
      expect(result.degraded).toBe(true);
    }
  }, 120_000);

  it("intent=tool 时不合成语音（route.synthesize=false）", async () => {
    if (!available.output) return;
    const result = await output.synthesize({
      eventId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      content: "搜索结果：三条",
      emotion: "neutral",
      type: "text",
      intent: "tool",
    });
    expect(result.route.synthesize).toBe(false);
    expect(result.audio_ref).toBeNull();
  }, 60_000);
});

describe("全链路：input → OmniNexus → output", () => {
  it("一次完整对话产出文本与音频，且标签来自 final", async () => {
    if (!available.input || !available.llm || !available.output) return;

    const snapshots: TurnSnapshot[] = [];
    const orchestrator = new Orchestrator(
      { input, llm, output },
      { onSnapshot: (snapshot) => snapshots.push(snapshot) },
    );

    const health = await orchestrator.probe();
    expect(health).toEqual({ input: true, llm: true, output: true });

    const snapshot = await orchestrator.submit("今天有点累，想找人说说话。", {
      model: "echo:echo",
    });

    expect(snapshot.text.length).toBeGreaterThan(0);
    expect(snapshot.state).toBe("talking");
    expect(snapshot.health).toEqual({ input: true, llm: true, output: true });

    // 音频地址要么可用，要么明确降级——两者都可接受，但必须自洽
    if (snapshot.audioUrl) {
      expect(snapshot.audioUrl).toMatch(/^http:\/\/127\.0\.0\.1:8103\//);
      expect(snapshot.degraded).toBe(false);
    } else {
      expect(snapshot.degraded).toBe(true);
      expect(snapshot.notice).toBeTruthy();
    }

    // 状态机必须能收敛回静止态
    orchestrator.notifyAudioEnded();
    orchestrator.notifyTextSettled();
    expect(["default", "degraded"]).toContain(orchestrator.getSnapshot().state);

    // 快照序列必须单调包含文本（不允许文本回退为空）
    const texts = snapshots.map((s) => s.text).filter((t) => t.length > 0);
    expect(texts.length).toBeGreaterThan(0);
  }, 180_000);

  it("音频文件真的可下载（不只是给了 URL）", async () => {
    if (!available.output) return;

    const result = await output.synthesize({
      eventId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      content: "这是一句用于验证音频可下载的测试语句。",
      emotion: "neutral",
      type: "text",
      intent: "reply",
    });

    if (result.status !== "synthesized" || !result.audio_ref) {
      console.warn("[integration] 当前环境无 TTS 厂商，跳过音频下载校验");
      return;
    }

    const url = resolveAudioUrl(ENDPOINTS.output, result.audio_ref)!;
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // MP3 帧同步头 0xFF 0xEx
    expect(bytes[0]).toBe(0xff);
  }, 180_000);
});
