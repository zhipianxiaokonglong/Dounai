/**
 * 上游 HTTP 适配器。
 *
 * 三个模块各自独立，任何一个不可用都不得影响其他两个（见 docs/architecture.md §6）。
 * 因此每个适配器只抛自己的错误类型，由编排层决定降级表现。
 *
 * 传输层见 `transport.ts`：生产环境经主进程代理，开发环境经 Vite 代理，
 * 二者都不受浏览器跨域限制（原因见 docs/cors-and-proxy.md）。
 */

import {
  type InputDegradedInfo,
  type InputEvent,
  type LLMEvent,
  type MetaFrame,
  type OutputEvent,
  type RouteFrame,
  type UpstreamError,
  type CitationFrame,
  type WarningFrame,
  ContractError,
  parseCitations,
  parseInputDegraded,
  parseInputEvent,
  parseLLMEvent,
  parseMeta,
  parseOutputEvent,
  parseRoute,
  parseUpstreamError,
  parseWarning,
} from "../contracts/index.js";
import { type HttpRequest, type HttpResponse, TransportError, request, requestStream } from "./transport.js";
import { buildMultipart, guessExtension } from "./multipart.js";

export class UpstreamUnavailableError extends Error {
  readonly module: string;
  constructor(module: string, detail: string) {
    super(`${module} 不可用：${detail}`);
    this.name = "UpstreamUnavailableError";
    this.module = module;
  }
}

export class UpstreamRejectedError extends Error {
  readonly module: string;
  readonly upstream: UpstreamError;
  constructor(module: string, upstream: UpstreamError) {
    super(`${module} 拒绝了请求：${upstream.code}`);
    this.name = "UpstreamRejectedError";
    this.module = module;
    this.upstream = upstream;
  }
}

export class TimeoutError extends Error {
  readonly module: string;
  readonly stage: string;
  constructor(module: string, stage: string, ms: number) {
    super(`${module} 在 ${stage} 阶段超时（${ms}ms）`);
    this.name = "TimeoutError";
    this.module = module;
    this.stage = stage;
  }
}

export interface Endpoints {
  input: string;
  llm: string;
  output: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = {
  input: "http://127.0.0.1:8101",
  llm: "http://127.0.0.1:8102",
  output: "http://127.0.0.1:8103",
};

export const TIMEOUTS = {
  inputText: 15_000,
  inputMedia: 60_000,
  llmFirstToken: 45_000,
  llmTotal: 120_000,
  outputSynthesis: 90_000,
  probe: 3_000,
} as const;

/** 本地类型守卫：契约解析在 contracts 里，这里只用于适配器内部的宽松取值。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把相对 audio_ref 拼成可播放的绝对地址。 */
export function resolveAudioUrl(outputBase: string, audioRef: string | null): string | null {
  if (!audioRef) return null;
  if (/^https?:\/\//i.test(audioRef)) return audioRef;
  const base = outputBase.replace(/\/+$/, "");
  const path = audioRef.startsWith("/") ? audioRef : `/${audioRef}`;
  return `${base}${path}`;
}

async function readJson(response: HttpResponse): Promise<unknown> {
  const text = response.body;
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContractError("upstream", "body", "响应不是合法 JSON");
  }
}

/** 把传输层错误翻译成上游错误，保留超时语义。 */
function toUpstreamError(module: string, stage: string, error: unknown): Error {
  if (error instanceof TimeoutError) return error;
  if (error instanceof TransportError) {
    if (error.kind === "timeout") {
      return new TimeoutError(module, stage, 0);
    }
    return new UpstreamUnavailableError(module, error.message);
  }
  if (error instanceof Error) return new UpstreamUnavailableError(module, error.message);
  return new UpstreamUnavailableError(module, String(error));
}

/* ------------------------------------------------------------------ */
/* input                                                               */
/* ------------------------------------------------------------------ */

export interface SubmitTextResult {
  event: InputEvent;
  degraded: InputDegradedInfo;
}

export class InputAdapter {
  constructor(private readonly base: string) {}

  async probe(): Promise<boolean> {
    try {
      const res = await request({
        url: `${this.base}/healthz`,
        method: "GET",
        timeoutMs: TIMEOUTS.probe,
      });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  async submitText(text: string, sessionId?: string): Promise<SubmitTextResult> {
    const body = JSON.stringify({
      text,
      ...(sessionId ? { session_id: sessionId } : {}),
      source: "dounai-desktop",
    });

    let response: HttpResponse;
    try {
      response = await request({
        url: `${this.base}/v1/inputs/text`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        timeoutMs: TIMEOUTS.inputText,
      });
    } catch (error) {
      throw toUpstreamError("input", "submitText", error);
    }

    return this.finish(response);
  }

  /**
   * 图像输入。
   *
   * 输入层用 multipart + 魔数双重校验，因此必须带真实文件名与 MIME；
   * 单文件上限 15MB，超限由上游返回 413（这里不预检，避免重复实现上游规则）。
   */
  async submitImage(
    image: { bytes: Uint8Array; filename?: string; mime?: string },
    sessionId?: string,
  ): Promise<SubmitTextResult> {
    const mime = image.mime ?? "image/png";
    const filename = image.filename ?? `paste.${guessExtension("", mime)}`;
    return this.submitFile("image", { bytes: image.bytes, filename, mime }, sessionId, {});
  }

  /**
   * 语音输入。
   *
   * `language` 是可选 BCP-47（如 `zh`、`en-US`）；上游会据此选择 ASR 语言。
   * 转写失败时上游仍返回 201，但 `asr_text` 为空且响应头 `X-Dounai-Degraded: true`
   * —— 这就是「语音没转写成功」的唯一可信信号，必须由调用方读取。
   */
  async submitAudio(
    audio: { bytes: Uint8Array; filename?: string; mime?: string; language?: string },
    sessionId?: string,
  ): Promise<SubmitTextResult> {
    const mime = audio.mime ?? "audio/webm";
    const filename = audio.filename ?? `voice.${guessExtension("", mime)}`;
    return this.submitFile(
      "audio",
      { bytes: audio.bytes, filename, mime },
      sessionId,
      audio.language ? { language: audio.language } : {},
    );
  }

  private async submitFile(
    kind: "image" | "audio",
    file: { bytes: Uint8Array; filename: string; mime: string },
    sessionId: string | undefined,
    extraFields: Record<string, string | undefined>,
  ): Promise<SubmitTextResult> {
    const form = buildMultipart(
      { field: "file", filename: file.filename, mime: file.mime, bytes: file.bytes },
      { session_id: sessionId, source: "dounai-desktop", ...extraFields },
    );

    let response: HttpResponse;
    try {
      response = await request({
        url: `${this.base}/v1/inputs/${kind}`,
        method: "POST",
        headers: { "Content-Type": form.contentType },
        bodyBytes: form.bytes,
        timeoutMs: TIMEOUTS.inputMedia,
      });
    } catch (error) {
      throw toUpstreamError("input", `submit${kind === "image" ? "Image" : "Audio"}`, error);
    }

    return this.finish(response);
  }

  private async finish(response: HttpResponse): Promise<SubmitTextResult> {
    const raw = await readJson(response);
    if (response.status >= 400) {
      throw new UpstreamRejectedError("input", parseUpstreamError(raw));
    }
    return {
      event: parseInputEvent(raw),
      degraded: parseInputDegraded(response.headers),
    };
  }
}

/* ------------------------------------------------------------------ */
/* OmniNexus (SSE)                                                     */
/* ------------------------------------------------------------------ */

export interface TurnCallbacks {
  onMeta?(meta: MetaFrame): void;
  onRoute?(route: RouteFrame): void;
  onDelta?(event: LLMEvent): void;
  onCitations?(citations: CitationFrame): void;
  onWarning?(warning: WarningFrame): void;
  onFinal?(event: LLMEvent): void;
}

export interface TurnRequest {
  eventId: string;
  text: string;
  sessionId?: string;
  model?: string;
  /**
   * 本轮使用的提示词配置 ID（结构图「提示词操作：预留更换接口供 UI 调用」）。
   *
   * 用 model 层支持的**每轮覆盖**语义（`metadata.prompt_profile`），
   * 而不是先建会话再切提示词——后者需要组装层维护会话生命周期，
   * 会让「换提示词」这种轻量操作牵动状态管理。
   */
  promptProfile?: string;
}

/** 提示词配置（模型层 `/v1/prompts/profiles` 的返回项）。 */
export interface PromptProfile {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  activeVersion: number;
}

export class LLMAdapter {
  constructor(private readonly base: string) {}

  async probe(): Promise<boolean> {
    try {
      const res = await request({
        url: `${this.base}/v1/healthz`,
        method: "GET",
        timeoutMs: TIMEOUTS.probe,
      });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  /**
   * 列出可用提示词配置。
   *
   * 失败时返回空数组而不是抛错：提示词选择是**增强功能**，
   * 拿不到列表不应该让整个对话不可用（用户仍可用默认配置聊天）。
   */
  async listPromptProfiles(): Promise<PromptProfile[]> {
    try {
      const res = await request({
        url: `${this.base}/v1/prompts/profiles`,
        method: "GET",
        timeoutMs: TIMEOUTS.probe,
      });
      if (res.status >= 400) return [];
      const raw = await readJson(res);
      const list = isRecord(raw) && Array.isArray(raw.profiles) ? raw.profiles : [];
      return list.filter(isRecord).map((item) => ({
        id: String(item.id ?? ""),
        name: String(item.name ?? item.id ?? ""),
        description: String(item.description ?? ""),
        builtin: Boolean(item.builtin),
        activeVersion: Number(item.active_version ?? 0),
      })).filter((item) => item.id.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * 跑一个完整回合。返回 final 事件；若上游在产生文本前失败则抛错。
   *
   * 注意：这里**不**在首 token 处返回，而是等到 final —— 因为 output 需要完整文本。
   * 流式体验由 onDelta 回调即时推给 UI，二者互不阻塞。
   */
  async runTurn(
    turn: TurnRequest,
    callbacks: TurnCallbacks,
    signal?: AbortSignal,
  ): Promise<LLMEvent> {
    const body = JSON.stringify({
      event_id: turn.eventId,
      parts: [{ modality: "text", content: turn.text }],
      metadata: {
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
        // 每轮覆盖提示词配置；不传则沿用模型层默认
        ...(turn.promptProfile ? { prompt_profile: turn.promptProfile } : {}),
      },
    });

    const httpRequest: HttpRequest = {
      url: `${this.base}/v1/events`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body,
      timeoutMs: TIMEOUTS.llmTotal,
      signal,
    };

    const collector = createCollector(callbacks);

    try {
      await requestStream(httpRequest, (chunk) => collector.feed(chunk));
    } catch (error) {
      throw toUpstreamError("omninexus", "stream", error);
    }

    return collector.finish();
  }
}

/**
 * SSE 帧收集器。
 *
 * 逐帧 JSON.parse，单帧损坏只跳过并计数，不让整轮失败——
 * 上游已产生的文本不能因一帧坏掉而丢弃。
 */
function createCollector(callbacks: TurnCallbacks) {
  let buffer = "";
  let finalEvent: LLMEvent | null = null;
  let failure: UpstreamError | null = null;
  let sawWarning = false;
  let badFrames = 0;
  /** 已收到终止帧（final / error）：读取方可立即停止，无需等待 socket EOF */
  let terminated = false;

  function dispatch(rawFrame: string): void {
    let name = "";
    const dataLines: string[] = [];

    for (const line of rawFrame.split(/\r?\n/)) {
      if (line.startsWith(":")) continue; // keep-alive 注释
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;

    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join("\n")) as unknown;
    } catch {
      badFrames += 1;
      return;
    }

    try {
      switch (name) {
        case "meta":
          callbacks.onMeta?.(parseMeta(payload));
          break;
        case "route":
          callbacks.onRoute?.(parseRoute(payload));
          break;
        case "delta":
          callbacks.onDelta?.(parseLLMEvent(payload, true));
          break;
        case "citations":
          callbacks.onCitations?.(parseCitations(payload));
          break;
        case "warning":
          callbacks.onWarning?.(parseWarning(payload));
          sawWarning = true;
          break;
        case "error":
          failure = parseUpstreamError(payload);
          terminated = true;
          break;
        case "final": {
          const event = parseLLMEvent(payload, false);
          finalEvent = event;
          terminated = true;
          callbacks.onFinal?.(event);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      // 契约字段缺失：记为坏帧，不中断整轮
      if (error instanceof ContractError) badFrames += 1;
      else throw error;
    }
  }

  return {
    /** 返回 true 表示已收到终止帧，调用方应停止读取。 */
    feed(chunk: string): boolean {
      buffer += chunk;
      for (;;) {
        const boundary = findBoundary(buffer);
        if (boundary === -1) break;
        const rawFrame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        dispatch(rawFrame);
        if (terminated) return true;
      }
      return terminated;
    },
    finish(): LLMEvent {
      // 末尾可能没有空行分隔，兜底再派发一次
      if (buffer.trim().length > 0) {
        dispatch(buffer);
        buffer = "";
      }
      if (failure) throw new UpstreamRejectedError("omninexus", failure);
      if (!finalEvent) {
        throw new UpstreamUnavailableError(
          "omninexus",
          sawWarning ? "流在产生 final 前中断" : "流结束但未收到 final",
        );
      }
      if (badFrames > 0 && finalEvent.content.length === 0) {
        throw new UpstreamUnavailableError("omninexus", `全部 ${badFrames} 帧均无法解析`);
      }
      return finalEvent;
    },
  };
}

function findBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/* ------------------------------------------------------------------ */
/* output                                                              */
/* ------------------------------------------------------------------ */

export interface SynthesisRequest {
  eventId: string;
  sessionId: string;
  content: string;
  emotion: string;
  type: string;
  intent: string;
}

export class OutputAdapter {
  constructor(private readonly base: string) {}

  async probe(): Promise<boolean> {
    try {
      const res = await request({
        url: `${this.base}/api/health`,
        method: "GET",
        timeoutMs: TIMEOUTS.probe,
      });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  async synthesize(synth: SynthesisRequest, signal?: AbortSignal): Promise<OutputEvent> {
    const body = JSON.stringify({
      event_id: synth.eventId,
      session_id: synth.sessionId,
      content: synth.content,
      stream: false,
      tags: {
        emotion: synth.emotion,
        type: synth.type,
        intent: synth.intent,
      },
    });

    let response: HttpResponse;
    try {
      response = await request({
        url: `${this.base}/api/v1/outputs`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        timeoutMs: TIMEOUTS.outputSynthesis,
        signal,
      });
    } catch (error) {
      throw toUpstreamError("output", "synthesize", error);
    }

    const raw = await readJson(response);
    if (response.status >= 400) {
      throw new UpstreamRejectedError("output", parseUpstreamError(raw));
    }
    return parseOutputEvent(raw);
  }

  audioUrl(audioRef: string | null): string | null {
    return resolveAudioUrl(this.base, audioRef);
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  module: string,
  stage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(module, stage, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把上游错误码映射为面向用户的短句；不展示上游原文。 */
export function userFacingError(error: unknown): string {
  if (error instanceof TimeoutError) {
    if (error.module === "omninexus") return "模型响应超时，稍后再试一次。";
    if (error.module === "input") return "输入处理超时，请重试。";
    return "语音合成超时，本条先只显示文字。";
  }
  if (error instanceof UpstreamUnavailableError) {
    if (error.module === "input") return "输入服务未连接，请检查输入层是否已启动。";
    if (error.module === "omninexus") return "模型服务未连接，请检查模型层是否已启动。";
    return "语音服务未连接，本条先只显示文字。";
  }
  if (error instanceof UpstreamRejectedError) {
    switch (error.upstream.code) {
      case "NO_PROVIDER_AVAILABLE":
      case "ALL_PROVIDERS_FAILED":
        return "还没有可用的模型，请先在模型层配置一个厂商密钥。";
      case "PROVIDER_AUTH":
        return "模型厂商鉴权失败，请检查密钥。";
      case "PROVIDER_RATE_LIMITED":
        return "模型厂商限流了，稍后再试。";
      case "GENERATION_INTERRUPTED":
        return "回答生成到一半中断了，已保留前面的内容。";
      case "INVALID_INPUT":
        return "这条输入格式不对，换一种说法试试。";
      case "origin_not_allowed":
        return "上游拒绝了跨域请求，请通过桌面应用运行（详见排障文档）。";
      default:
        return "上游服务返回了错误，稍后重试。";
    }
  }
  if (error instanceof ContractError) return "上游返回的数据格式异常，已降级显示。";
  return "出了点问题，稍后重试。";
}
