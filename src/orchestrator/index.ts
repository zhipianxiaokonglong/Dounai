/**
 * 回合编排器：状态机 + 事件归并 + 降级。
 *
 * 状态定义见 docs/architecture.md §3。核心约束：
 *  1. 任意外部状态都可被 degraded 覆盖；
 *  2. 说话态结束以音频播放完毕为准，不以 final 到达为准；
 *  3. output 失败不得影响文本显示。
 */

import type { LLMEvent, LLMPart, OutputEvent } from "../contracts/index.js";
import {
  type InputAdapter,
  type LLMAdapter,
  type OutputAdapter,
  UpstreamRejectedError,
  UpstreamUnavailableError,
  userFacingError,
} from "../upstream/adapters.js";

/** 构造后的内部标记：本轮是否由声纹唤醒触发 */
const WAKE_FLAG = Symbol("wake");

export type UiState = "default" | "wakeup" | "talking" | "emotion" | "degraded";

export interface ModuleHealth {
  input: boolean;
  llm: boolean;
  output: boolean;
}

export interface TurnSnapshot {
  state: UiState;
  /** 已上屏文本（delta 累积后由 final 校正） */
  text: string;
  /** 情感标签（final 为准；预留情感态） */
  emotion: string | null;
  contentType: string;
  intent: string;
  /** 语音是否可用；text_fallback 时为 false */
  audioUrl: string | null;
  /** 面向用户的提示（降级/错误），无错误时为 null */
  notice: string | null;
  health: ModuleHealth;
  /** 本轮是否发生过降级 */
  degraded: boolean;
  /** 本轮输入模态，供 UI 区分气泡样式（语音/图像/文字） */
  modality: "text" | "image" | "audio";
}

/**
 * 用户提交的载荷。
 *
 * 与结构图一致：UI 侧提供文字 / 图像 / 语音三种入口，
 * 三者最终都由输入层归一化成同一种事件，再走同一条下游链路。
 */
export type SubmitPayload =
  | { kind: "text"; text: string }
  | {
      kind: "image";
      bytes: Uint8Array;
      filename?: string;
      mime?: string;
      /**
       * 当前模型是否声明支持图片输入。
       *
       * 由 UI 从 `/v1/models` 的 `capabilities.inputModalities` 读取后传入。
       * 为 `false` 时**不发送**——上游收到不支持的图片只会降级成一句
       * "[Image attachment omitted]"，用户看到的是"答非所问"。
       * 未传（undefined）表示未知，交给上游判定。
       */
      modelSupportsImage?: boolean;
    }
  | { kind: "audio"; bytes: Uint8Array; filename?: string; mime?: string; language?: string };

export interface OrchestratorEvents {
  onSnapshot(snapshot: TurnSnapshot): void;
  /** 音频起播/结束，由 UI 层回调，用于驱动 talking 态的真实生命周期 */
  onAudioEnded?(): void;
}

/**
 * 从输入事件 + 用户原始载荷构造模型层的内容分区（D-02）。
 *
 * 为什么这里需要两手信息：
 * - 图像：事件体只给了回环 URL，**字节必须来自我们自己的 `input.bytes`**；
 * - 语音：事件体给了 `asr_text` 与 `asr_status`，但音频字节在模型层是没用的
 *   （模型层不做 ASR），所以语音只能转成文本；转写不可用时必须报错而不是
 *   把 `content`（回环 URL）当文本发出去。
 */
type BuildPartsResult =
  | { ok: true; parts: LLMPart[] }
  | { ok: false; notice: string };

function buildParts(
  input: SubmitPayload,
  event: { content: string; metadata: { asr_text: string; asr_status: string } },
): BuildPartsResult {
  if (input.kind === "text") {
    return { ok: true, parts: [{ modality: "text", content: input.text }] };
  }

  if (input.kind === "image") {
    // 先检查模型能力：不支持就**不发**，直接说明原因
    if (input.modelSupportsImage === false) {
      return {
        ok: false,
        notice:
          "当前模型不支持图片输入，这张图不会被读取。\n" +
          "请在设置里换一个「可看图」的模型（面板顶部模型下拉里会标注），" +
          "或在启动器「厂商」页为模型层接入一个视觉模型。",
      };
    }

    const mime = input.mime ?? guessImageMime(input.filename);
    if (!mime.startsWith("image/")) {
      return { ok: false, notice: "图片类型无法识别，换一张 PNG / JPEG / WebP 再试。" };
    }

    // 体积保护：先估算，超限就不发送。
    // 不做自动降采样——重编码会损害小字识别，而"读出图片文字"正是本项要支持的场景。
    // 与其悄悄把图压糊，不如明确告诉用户"太大、请处理"，让用户自己决定怎么裁。
    const chars = estimateDataUrlChars(input.bytes.byteLength, mime);
    if (chars > MAX_IMAGE_PART_CHARS) {
      // 反推"还能发多大的原图"（用同一膨胀比），给出可执行建议
      const maxBinaryBytes = Math.floor((MAX_IMAGE_PART_CHARS - 64) / 4 * 3);
      return {
        ok: false,
        notice:
          `图片太大（约 ${mbOf(input.bytes.byteLength)} MB，单张上限约 ` +
          `${mbOf(maxBinaryBytes)} MB）。请裁剪或压缩后重试——` +
          "我没有自动压缩，因为压缩会降低图内文字的识别效果。",
      };
    }

    const dataUrl = toDataUrl(input.bytes, mime);
    return {
      ok: true,
      parts: [
        {
          modality: "image",
          content: dataUrl,
          metadata: {
            mime_type: mime,
            ...(input.filename ? { filename: input.filename } : {}),
          },
        },
      ],
    };
  }

  // 语音：只有上游明确说"转写完成"才可用。
  //
  // 按 asr_status 区分提示（对齐上游 4 值枚举，见 contracts 里的注释）：
  // empty 是"没说话"，让用户再说一次；unavailable 才是"能力缺失"，该去配置。
  // 混为一谈会让用户对着一个空录音去查厂商密钥。
  const transcript = event.metadata.asr_text.trim();
  if (event.metadata.asr_status !== "completed" || !transcript) {
    const notice =
      event.metadata.asr_status === "empty"
        ? "没有听到语音内容，请再说一次，或改用文字输入。"
        : "语音转写不可用（输入层没有可用的转写能力）。可以改用文字输入，" +
          "或在启动器「厂商」页为输入层配置带转写能力的厂商。";
    return { ok: false, notice };
  }
  return { ok: true, parts: [{ modality: "text", content: transcript }] };
}

/**
 * 单个图像分区允许的**字符**上限，取自模型层 `MAX_PART_CHARS`。
 *
 * 留出余量：一条事件可能还有别的分区与 metadata，全用满会顶到 12,000,000。
 */
const MAX_IMAGE_PART_CHARS = 10_000_000;

/**
 * base64 编码后的字符数（含 data URI 前缀）。
 *
 * 不用真正编码就能算：base64 长度 = ceil(n/3)*4，加前缀长度。
 * 先算再决定是否编码，避免为一张必然被拒的大图白白做几十 MB 的字符串拼接。
 */
function estimateDataUrlChars(byteLength: number, mime: string): number {
  const base64Len = Math.ceil(byteLength / 3) * 4;
  // "data:" + mime + ";base64," + payload
  return "data:;base64,".length + mime.length + base64Len;
}

/** 字节数转成人类可读的 MB，用于提示文案。 */
function mbOf(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** 把字节编码成 data URI（模型层按 `data:` 前缀走 base64 分支）。 */
function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function guessImageMime(filename?: string): string {
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

const IDLE_SNAPSHOT: TurnSnapshot = {
  state: "default",
  text: "",
  emotion: null,
  contentType: "text",
  intent: "reply",
  audioUrl: null,
  notice: null,
  // 探活完成前按「可用」处理，避免首屏误报 degraded；
  // 真正的不可用由 probe() 的结果覆盖（见 docs/architecture.md §6）。
  health: { input: true, llm: true, output: true },
  degraded: false,
  modality: "text",
};

export class Orchestrator {
  private snapshot: TurnSnapshot = { ...IDLE_SNAPSHOT };
  private readonly handledFinals = new Set<string>();

  constructor(
    private readonly adapters: {
      input: InputAdapter;
      llm: LLMAdapter;
      output: OutputAdapter;
    },
    private readonly events: OrchestratorEvents,
  ) {}

  getSnapshot(): TurnSnapshot {
    return { ...this.snapshot };
  }

  /** 启动探活：三个模块并行探测，任一失败只影响对应能力。 */
  async probe(): Promise<ModuleHealth> {
    const [input, llm, output] = await Promise.all([
      this.adapters.input.probe(),
      this.adapters.llm.probe(),
      this.adapters.output.probe(),
    ]);
    const health: ModuleHealth = { input, llm, output };
    this.patch({ health, state: deriveState(this.snapshot.state, health) });
    return health;
  }

  /** 唤醒事件入口：由 input 的 voiceprint_event 或全局热键触发。 */
  wake(): void {
    if (this.snapshot.state === "talking") return;
    this.patch({ state: "wakeup" });
    setTimeout(() => {
      if (this.snapshot.state === "wakeup") this.patch({ state: "default" });
    }, 600);
  }

  /**
   * 处理一条用户输入，走完整链路。
   *
   * 支持文字 / 图像 / 语音三种模态（对应结构图的三个输入入口）。
   * 返回本轮结果快照。任何阶段失败都会落到 degraded 或「仅文本」，
   * 不向上抛异常——UI 永远不应该因为上游问题而崩溃。
   */
  async submit(
    payload: SubmitPayload | string,
    options: { sessionId?: string; model?: string; promptProfile?: string } = {},
  ): Promise<TurnSnapshot> {
    // 允许直接传字符串：调用方只关心「发一句话」时不必构造对象
    const input: SubmitPayload =
      typeof payload === "string" ? { kind: "text", text: payload } : payload;

    // 文字为空时不发起请求，避免无意义的空回合
    if (input.kind === "text" && !input.text.trim()) return this.getSnapshot();

    this.patch({
      state: "wakeup",
      text: "",
      emotion: null,
      audioUrl: null,
      notice: null,
      degraded: false,
      modality: input.kind,
    });

    // 0) 先做能力预检：模型不支持图片时**一次上传都不该发**。
    //
    // 这一步必须在调 input 适配器之前——否则图片已经传完才发现不支持，
    // 既浪费带宽，语义上也像是"发了但没被理解"。
    if (input.kind === "image" && input.modelSupportsImage === false) {
      this.patch({
        state: "degraded",
        notice:
          "当前模型不支持图片输入，这张图不会被读取。\n" +
          "请在面板顶部的模型下拉里换一个标注「可看图」的模型，" +
          "或在启动器「厂商」页为模型层接入一个视觉模型。",
        degraded: true,
      });
      return this.getSnapshot();
    }

    // 1) input：把用户输入归一化成标准事件
    let inputEvent;
    try {
      const result =
        input.kind === "text"
          ? await this.adapters.input.submitText(input.text.trim(), options.sessionId)
          : input.kind === "image"
            ? await this.adapters.input.submitImage(
                { bytes: input.bytes, filename: input.filename, mime: input.mime },
                options.sessionId,
              )
            : await this.adapters.input.submitAudio(
                {
                  bytes: input.bytes,
                  filename: input.filename,
                  mime: input.mime,
                  language: input.language,
                },
                options.sessionId,
              );

      inputEvent = result.event;

      // 结构图：声纹识别/唤醒（本地）→ voiceprint_event: wakeup → 唤醒态
      // 这是「唤醒态」的唯一上游来源；热键只是本地补充入口。
      if (inputEvent.metadata.voiceprint_event === "wakeup") {
        this.patch({ state: "wakeup" });
      }

      if (result.degraded.degraded) {
        // 输入层的降级只存在于响应头（如语音未转写成功），必须显式告知用户
        this.patch({ degraded: true, notice: degradedNotice("input") });
      }
    } catch (error) {
      this.patch({
        state: "degraded",
        notice: userFacingError(error),
        health: { ...this.snapshot.health, input: false },
      });
      return this.getSnapshot();
    }

    // 2) 构造发往模型层的内容分区（D-02）
    //
    // 关键：输入层事件里的 `content` 是**本机回环 URL**，模型层取不到，
    // 也不能当描述文本用。图像必须用我们手上真实的字节生成 data URI，
    // 模型层的 provider 层会走 base64 内联分支。
    const built = buildParts(input, inputEvent);
    if (!built.ok) {
      // 例如语音未转写成功：明确告知，而不是把音频 URL 当文本发出去
      this.patch({
        state: "degraded",
        notice: built.notice,
        degraded: true,
        modality: input.kind,
      });
      return this.getSnapshot();
    }

    // 局部常量：图像输入时就排队记忆；是否可用随计划返回
    let streamed = "";
    let finalEvent: LLMEvent;
    try {
      finalEvent = await this.adapters.llm.runTurn(
        {
          eventId: inputEvent.event_id,
          parts: built.parts,
          sessionId: options.sessionId,
          model: options.model,
          promptProfile: options.promptProfile,
        },
        {
          onDelta: (event) => {
            // 同一帧可能被上游重放；用「更长者为准」避免文本回退
            if (event.content.length >= streamed.length || streamed.length === 0) {
              streamed = event.content;
            }
            this.patch({ state: "talking", text: streamed });
          },
          onFinal: (event) => {
            streamed = event.content;
            this.patch({ state: "talking", text: streamed });
          },
        },
      );
    } catch (error) {
      const notice = userFacingError(error);
      const retryable = error instanceof UpstreamRejectedError ? error.upstream.retryable : true;
      this.patch({
        state: "degraded",
        notice,
        degraded: true,
        health: { ...this.snapshot.health, llm: !(error instanceof UpstreamUnavailableError) },
      });
      // 已流出的部分文本保留，便于用户看到「说到一半」
      if (streamed) this.patch({ text: streamed });
      void retryable;
      return this.getSnapshot();
    }

    // 3) 幂等：同一 final 只处理一次
    if (this.handledFinals.has(finalEvent.event_id)) {
      return this.getSnapshot();
    }
    this.handledFinals.add(finalEvent.event_id);

    // final 是权威值：校正文本与标签
    this.patch({
      text: finalEvent.content,
      emotion: finalEvent.tags.emotion,
      contentType: finalEvent.tags.type,
      intent: finalEvent.tags.intent,
      state: "talking",
    });

    // 4) output：合成语音；失败只影响音频
    try {
      const output = await this.adapters.output.synthesize({
        eventId: finalEvent.event_id,
        sessionId: finalEvent.session_id,
        content: finalEvent.content,
        emotion: finalEvent.tags.emotion,
        type: finalEvent.tags.type,
        intent: finalEvent.tags.intent,
      });
      this.applyOutput(output);
    } catch (error) {
      this.patch({
        audioUrl: null,
        degraded: true,
        notice: userFacingError(error),
        health: { ...this.snapshot.health, output: false },
      });
    }

    return this.getSnapshot();
  }

  /** 由 UI 在音频真正播放结束时调用；这是 talking → default 的唯一合法路径。 */
  notifyAudioEnded(): void {
    if (this.snapshot.state === "talking") {
      this.patch({
        state: this.restingState(),
        audioUrl: null,
        // 一轮结束即清除本轮降级提示；模块级不可用由 health 徽标持续表达
        notice: null,
        degraded: false,
      });
    }
  }

  /** 无音频可播（text_only / text_fallback）时，文本渲染完即回到 default。 */
  notifyTextSettled(): void {
    if (this.snapshot.state === "talking" && !this.snapshot.audioUrl) {
      this.patch({ state: this.restingState(), notice: null, degraded: false });
    }
  }

  /** 回合结束后的静止态：模块级不可用仍然显示 degraded，否则回到 default。 */
  private restingState(): UiState {
    const { input, llm } = this.snapshot.health;
    return input && llm ? "default" : "degraded";
  }

  reset(): void {
    this.handledFinals.clear();
    this.snapshot = { ...IDLE_SNAPSHOT, health: this.snapshot.health };
    this.events.onSnapshot(this.getSnapshot());
  }

  private applyOutput(output: OutputEvent): void {
    const audioUrl =
      output.status === "synthesized" ? this.adapters.output.audioUrl(output.audio_ref) : null;
    const degraded = output.degraded || output.status === "text_fallback";
    this.patch({
      text: output.text || this.snapshot.text,
      // 情感标签以 LLM 的 final 为准（见 docs/contracts.md §2.1）；
      // output 的 style.emotion 只是它自己的映射结果，不覆盖上游标签。
      contentType: output.render.type || this.snapshot.contentType,
      audioUrl,
      degraded,
      notice: degraded ? "语音暂不可用，本条只显示文字。" : null,
      health: { ...this.snapshot.health, output: true },
    });
  }

  private patch(partial: Partial<TurnSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.events.onSnapshot(this.getSnapshot());
  }
}

function deriveState(current: UiState, health: ModuleHealth): UiState {
  if (!health.input || !health.llm) return "degraded";
  return current === "degraded" ? "default" : current;
}

function degradedNotice(module: string): string {
  if (module === "input") return "语音转写或声纹不可用，已按文字处理。";
  if (module === "output") return "语音合成降级，本条只显示文字。";
  return "上游发生降级。";
}
