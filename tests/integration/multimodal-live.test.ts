/**
 * 多模态与提示词的真实链路集成测试。
 *
 * 用真实输入层 / 模型层验证：图像上传、语音上传、提示词列表与按轮覆盖。
 * 上游未启动时自动跳过。
 */

import { beforeAll, describe, expect, it } from "vitest";
import { InputAdapter, LLMAdapter, OutputAdapter } from "../../src/upstream/adapters.js";
import { Orchestrator } from "../../src/orchestrator/index.js";

const LIVE = {
  input: process.env.DOUNAI_INPUT_URL ?? "http://127.0.0.1:8101",
  llm: process.env.DOUNAI_LLM_URL ?? "http://127.0.0.1:8102",
  output: process.env.DOUNAI_OUTPUT_URL ?? "http://127.0.0.1:8103",
};

const input = new InputAdapter(LIVE.input);
const llm = new LLMAdapter(LIVE.llm);
const output = new OutputAdapter(LIVE.output);

let live = { input: false, llm: false, output: false };

beforeAll(async () => {
  const [a, b, c] = await Promise.all([input.probe(), llm.probe(), output.probe()]);
  live = { input: a, llm: b, output: c };
  if (!a || !b || !c) {
    console.warn(`[multimodal] 上游未全部就绪 input=${a} llm=${b} output=${c}，相关用例将跳过`);
  }
}, 30_000);

/** 构造一张最小但合法的 1x1 PNG（输入层按魔数校验）。 */
function tinyPng(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
    0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
    0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

/** 构造一个最小 WAV 头 + 静音（输入层接受 wav，且离线时不会真去转写）。 */
function tinyWav(): Uint8Array {
  const samples = 1600; // 0.1s @16kHz 单声道 16bit
  const dataSize = samples * 2;
  const buffer = new Uint8Array(44 + dataSize);
  const view = new DataView(buffer.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) buffer[offset + i] = text.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, 16000, true); // 采样率
  view.setUint32(28, 32000, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  return buffer;
}

describe("真实输入层：图像输入", () => {
  it("上传 PNG 得到 modality=image 的事件，content 为受控媒体 URL", async () => {
    if (!live.input) return;

    const result = await input.submitImage({
      bytes: tinyPng(),
      filename: "probe.png",
      mime: "image/png",
    });

    expect(result.event.modality).toBe("image");
    expect(result.event.content).toContain("/v1/media/");
    expect(result.event.event_id).toMatch(/^[0-9a-f-]{36}$/i);
  }, 60_000);

  it("伪造内容（非图片字节）被上游拒绝，而不是静默通过", async () => {
    if (!live.input) return;
    await expect(
      input.submitImage({
        bytes: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]),
        filename: "fake.png",
        mime: "image/png",
      }),
    ).rejects.toThrow();
  }, 60_000);
});

describe("真实输入层：语音输入", () => {
  it("上传 WAV 得到 modality=audio 的事件，转写结果在 metadata.asr_text", async () => {
    if (!live.input) return;

    const result = await input.submitAudio({
      bytes: tinyWav(),
      filename: "probe.wav",
      mime: "audio/wav",
      language: "zh",
    });

    expect(result.event.modality).toBe("audio");
    // 离线 provider 不转写，asr_text 应为空且响应头标记降级
    expect(typeof result.event.metadata.asr_text).toBe("string");
    expect(result.event.metadata.voiceprint_event).toBe("none");
  }, 90_000);
});

describe("真实模型层：提示词接口", () => {
  it("能列出内置提示词配置", async () => {
    if (!live.llm) return;

    const profiles = await llm.listPromptProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.some((profile) => profile.id === "default")).toBe(true);
  }, 30_000);

  it("按轮覆盖 prompt_profile 不报错（未知 ID 由上游判定）", async () => {
    if (!live.llm) return;

    const final = await llm.runTurn(
      {
        eventId: crypto.randomUUID(),
        text: "你好",
        model: "echo:echo",
        promptProfile: "default",
      },
      {},
    );
    expect(final.content.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("真实全链路：图像输入", () => {
  it("图像事件也能走通 input → 模型 → 语音", async () => {
    if (!live.input || !live.llm || !live.output) return;

    const orchestrator = new Orchestrator(
      { input, llm, output },
      { onSnapshot: () => undefined },
    );

    const snapshot = await orchestrator.submit(
      { kind: "image", bytes: tinyPng(), filename: "probe.png", mime: "image/png" },
      { model: "echo:echo" },
    );

    expect(snapshot.modality).toBe("image");
    expect(snapshot.text.length).toBeGreaterThan(0);
    // 语音可能因 TTS 不可用而降级，但文本必须在
    if (!snapshot.audioUrl) expect(snapshot.degraded).toBe(true);
  }, 180_000);
});
