/**
 * 上游契约的类型定义与**宽松解析器**。
 *
 * 设计原则（见 docs/contracts.md §5）：
 *  - 忽略未知字段：上游加字段不应让本层崩溃；
 *  - 缺失可选字段给默认值；
 *  - 缺失必填字段抛 ContractError，由调用方降级处理，绝不静默产出半成品。
 */

export class ContractError extends Error {
  readonly source: string;
  readonly field: string;

  constructor(source: string, field: string, detail: string) {
    super(`${source}: ${field} — ${detail}`);
    this.name = "ContractError";
    this.source = source;
    this.field = field;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const bool = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/* ------------------------------------------------------------------ */
/* input                                                               */
/* ------------------------------------------------------------------ */

export type Modality = "text" | "image" | "audio";

export interface InputMetadata {
  asr_text: string;
  voiceprint_event: "wakeup" | "none";
  model_capabilities: Modality[];
}

export interface InputEvent {
  event_id: string;
  timestamp: string;
  modality: Modality;
  content: string;
  metadata: InputMetadata;
}

/** input 的降级信息只存在于响应头，不在事件体里。 */
export interface InputDegradedInfo {
  degraded: boolean;
  provider: string | null;
  model: string | null;
  voiceprintChecked: boolean;
  requestId: string | null;
}

const MODALITIES: Modality[] = ["text", "image", "audio"];

export function parseInputEvent(raw: unknown): InputEvent {
  if (!isRecord(raw)) throw new ContractError("input", "body", "不是对象");

  const eventId = str(raw.event_id);
  if (!eventId) throw new ContractError("input", "event_id", "缺失");

  const modality = MODALITIES.includes(raw.modality as Modality)
    ? (raw.modality as Modality)
    : null;
  if (!modality) {
    throw new ContractError("input", "modality", `未知取值 ${String(raw.modality)}`);
  }

  const content = str(raw.content);
  if (!content.trim()) throw new ContractError("input", "content", "缺失或为空");

  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const capabilities = Array.isArray(metadata.model_capabilities)
    ? metadata.model_capabilities.filter((item): item is Modality =>
        MODALITIES.includes(item as Modality),
      )
    : [];

  return {
    event_id: eventId,
    timestamp: str(raw.timestamp),
    modality,
    content,
    metadata: {
      asr_text: str(metadata.asr_text),
      voiceprint_event: metadata.voiceprint_event === "wakeup" ? "wakeup" : "none",
      model_capabilities: capabilities,
    },
  };
}

export function parseInputDegraded(headers: Record<string, string>): InputDegradedInfo {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    degraded: lower["x-dounai-degraded"] === "true",
    provider: lower["x-dounai-provider"] ?? null,
    model: lower["x-dounai-model"] ?? null,
    voiceprintChecked: lower["x-dounai-voiceprint-checked"] === "true",
    requestId: lower["x-request-id"] ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* OmniNexus                                                           */
/* ------------------------------------------------------------------ */

export type Emotion =
  | "joy"
  | "sadness"
  | "anger"
  | "fear"
  | "surprise"
  | "confusion"
  | "frustration"
  | "gratitude"
  | "neutral";

export type ContentType = "text" | "code" | "list" | "table" | "json" | "mixed";
export type Intent = "reply" | "tool" | "linkage";

export interface OutputTags {
  emotion: string;
  type: string;
  intent: string;
}

export interface LLMEvent {
  event_id: string;
  session_id: string;
  content: string;
  stream: boolean;
  tags: OutputTags;
}

export interface MetaFrame {
  event_id: string;
  session_id: string;
  planned_model?: string;
  requested_model?: string;
  prompt_profile?: string;
  web_search_requested?: boolean;
}

export interface RouteFrame {
  provider: string;
  model: string;
  fallback: boolean;
}

export interface WarningFrame {
  code?: string;
  message?: string;
}

export interface CitationFrame {
  citations: Array<Record<string, unknown>>;
}

export function parseLLMEvent(raw: unknown, stream: boolean): LLMEvent {
  if (!isRecord(raw)) throw new ContractError("omninexus", "frame", "不是对象");

  const eventId = str(raw.event_id);
  if (!eventId) throw new ContractError("omninexus", "event_id", "缺失");

  const tagsRaw = isRecord(raw.tags) ? raw.tags : {};
  return {
    event_id: eventId,
    session_id: str(raw.session_id),
    content: str(raw.content),
    stream: bool(raw.stream, stream),
    tags: {
      // 上游未给标签时用中性值，避免 UI 出现空白状态
      emotion: str(tagsRaw.emotion, "neutral"),
      type: str(tagsRaw.type, "text"),
      intent: str(tagsRaw.intent, "reply"),
    },
  };
}

export function parseMeta(raw: unknown): MetaFrame {
  const value = isRecord(raw) ? raw : {};
  return {
    event_id: str(value.event_id),
    session_id: str(value.session_id),
    planned_model: typeof value.planned_model === "string" ? value.planned_model : undefined,
    requested_model: typeof value.requested_model === "string" ? value.requested_model : undefined,
    prompt_profile: typeof value.prompt_profile === "string" ? value.prompt_profile : undefined,
    web_search_requested:
      typeof value.web_search_requested === "boolean" ? value.web_search_requested : undefined,
  };
}

export function parseRoute(raw: unknown): RouteFrame {
  const value = isRecord(raw) ? raw : {};
  return {
    provider: str(value.provider, "unknown"),
    model: str(value.model, "unknown"),
    fallback: bool(value.fallback),
  };
}

export function parseWarning(raw: unknown): WarningFrame {
  const value = isRecord(raw) ? raw : {};
  return {
    code: typeof value.code === "string" ? value.code : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
  };
}

export function parseCitations(raw: unknown): CitationFrame {
  const value = isRecord(raw) ? raw : {};
  return {
    citations: Array.isArray(value.citations)
      ? value.citations.filter((item) => isRecord(item))
      : [],
  };
}

/** 上游错误体；message 不直接展示给用户，只用于映射文案。 */
export interface UpstreamError {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string | null;
}

export function parseUpstreamError(raw: unknown): UpstreamError {
  const root = isRecord(raw) ? raw : {};
  const error = isRecord(root.error) ? root.error : root;
  return {
    code: str(error.code, "UNKNOWN"),
    message: str(error.message),
    retryable: bool(error.retryable),
    requestId: typeof error.request_id === "string" ? error.request_id : null,
  };
}

/* ------------------------------------------------------------------ */
/* output                                                              */
/* ------------------------------------------------------------------ */

export type SynthesisStatus = "synthesized" | "text_only" | "text_fallback" | "preparing";

export interface StylePayload {
  emotion: string;
  label: string;
  speed: number;
  tone: string;
  description: string;
  pitch_semitones: number;
  source_tag: string;
  mapping_hit: boolean;
}

export interface RenderBlock {
  kind: string;
  content: string;
  language: string | null;
  ordinal: number | null;
}

export interface RenderPayload {
  type: string;
  mode: string;
  language: string | null;
  blocks: RenderBlock[];
  copyable: boolean;
}

export interface RoutePayload {
  intent: string;
  destination: string;
  synthesize: boolean;
  reason: string;
}

export interface TimingPayload {
  first_chunk_ms: number | null;
  total_ms: number | null;
}

export interface OutputEvent {
  event_id: string;
  text: string;
  audio_ref: string | null;
  style: StylePayload;
  speech_text: string;
  audio_mime: string | null;
  audio_format: string | null;
  render: RenderPayload;
  route: RoutePayload;
  provider: string | null;
  status: SynthesisStatus;
  degraded: boolean;
  timings: TimingPayload;
}

const STATUSES: SynthesisStatus[] = ["synthesized", "text_only", "text_fallback", "preparing"];

export function parseOutputEvent(raw: unknown): OutputEvent {
  if (!isRecord(raw)) throw new ContractError("output", "body", "不是对象");

  const eventId = str(raw.event_id);
  if (!eventId) throw new ContractError("output", "event_id", "缺失");

  const styleRaw = isRecord(raw.style) ? raw.style : {};
  const renderRaw = isRecord(raw.render) ? raw.render : {};
  const routeRaw = isRecord(raw.route) ? raw.route : {};
  const timingsRaw = isRecord(raw.timings) ? raw.timings : {};

  const blocks: RenderBlock[] = Array.isArray(renderRaw.blocks)
    ? renderRaw.blocks.filter(isRecord).map((block) => ({
        kind: str(block.kind, "text"),
        content: str(block.content),
        language: typeof block.language === "string" ? block.language : null,
        ordinal: typeof block.ordinal === "number" ? block.ordinal : null,
      }))
    : [];

  const status = STATUSES.includes(raw.status as SynthesisStatus)
    ? (raw.status as SynthesisStatus)
    : "text_fallback";

  return {
    event_id: eventId,
    text: str(raw.text),
    audio_ref: typeof raw.audio_ref === "string" && raw.audio_ref ? raw.audio_ref : null,
    style: {
      emotion: str(styleRaw.emotion, "neutral"),
      label: str(styleRaw.label),
      speed: num(styleRaw.speed, 1),
      tone: str(styleRaw.tone),
      description: str(styleRaw.description),
      pitch_semitones: num(styleRaw.pitch_semitones),
      source_tag: str(styleRaw.source_tag),
      mapping_hit: bool(styleRaw.mapping_hit, true),
    },
    speech_text: str(raw.speech_text),
    audio_mime: typeof raw.audio_mime === "string" ? raw.audio_mime : null,
    audio_format: typeof raw.audio_format === "string" ? raw.audio_format : null,
    render: {
      type: str(renderRaw.type, "text"),
      mode: str(renderRaw.mode, "plain"),
      language: typeof renderRaw.language === "string" ? renderRaw.language : null,
      blocks,
      copyable: bool(renderRaw.copyable),
    },
    route: {
      intent: str(routeRaw.intent, "reply"),
      destination: str(routeRaw.destination, "ui.text_reply"),
      synthesize: bool(routeRaw.synthesize, false),
      reason: str(routeRaw.reason),
    },
    provider: typeof raw.provider === "string" ? raw.provider : null,
    status,
    degraded: bool(raw.degraded),
    timings: {
      first_chunk_ms:
        typeof timingsRaw.first_chunk_ms === "number" ? timingsRaw.first_chunk_ms : null,
      total_ms: typeof timingsRaw.total_ms === "number" ? timingsRaw.total_ms : null,
    },
  };
}
