/**
 * 回合编排器：状态机 + 事件归并 + 降级。
 *
 * 状态定义见 docs/architecture.md §3。核心约束：
 *  1. 任意外部状态都可被 degraded 覆盖；
 *  2. 说话态结束以音频播放完毕为准，不以 final 到达为准；
 *  3. output 失败不得影响文本显示。
 */

import type { LLMEvent, OutputEvent } from "../contracts/index.js";
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
  | { kind: "image"; bytes: Uint8Array; filename?: string; mime?: string }
  | { kind: "audio"; bytes: Uint8Array; filename?: string; mime?: string; language?: string };

export interface OrchestratorEvents {
  onSnapshot(snapshot: TurnSnapshot): void;
  /** 音频起播/结束，由 UI 层回调，用于驱动 talking 态的真实生命周期 */
  onAudioEnded?(): void;
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

    // 2) OmniNexus：流式产出；delta 只用于即时上屏
    let streamed = "";
    let finalEvent: LLMEvent;
    try {
      finalEvent = await this.adapters.llm.runTurn(
        {
          eventId: inputEvent.event_id,
          // 语音输入优先用转写文本；图像输入用事件 content（受控媒体 URL）
          text: inputEvent.metadata.asr_text || inputEvent.content,
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
