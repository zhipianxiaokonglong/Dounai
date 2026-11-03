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

/**
 * ASR 状态（输入层 contract v1.1 起的机读字段）。
 *
 * 上游明确规定：**只有 `completed` 才可以把 `asr_text` 当可用文本**。
 * 这比"asr_text 是否为空"更可靠——空文本有时是合法的无语音输入。
 *
 * 语义区分（很重要，直接决定给用户什么提示）：
 * - `empty`：听清了但没有语音内容（按了录音没说话 / 纯静音）→ 让用户"再说一次"；
 * - `unavailable`：转写能力不可用（未配置 ASR 厂商 / 模型缺失）→ 才该提示去配置；
 * - `not_applicable`：本次输入根本不是语音；
 * - `completed`：转写成功，`asr_text` 可用。
 */
export type AsrStatus = "completed" | "empty" | "unavailable" | "not_applicable";

export interface InputMetadata {
  asr_text: string;
  voiceprint_event: "wakeup" | "none";
  model_capabilities: Modality[];
  asr_status: AsrStatus;
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

const ASR_STATUSES: AsrStatus[] = [
  "completed",
  "empty",
  "unavailable",
  "not_applicable",
];

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
  const asrStatus: AsrStatus = ASR_STATUSES.includes(
    metadata.asr_status as AsrStatus,
  )
    ? (metadata.asr_status as AsrStatus)
    : // 老版本上游没有该字段：退回按「有空文本即当完成」的历史行为，
      // 避免对接旧版时语音完全不可用
      str(metadata.asr_text).trim()
      ? "completed"
      : "not_applicable";
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
      asr_status: asrStatus,
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


/**
 * 校验并解析本轮要用的提示词配置（D-03）。
 *
 * 背景：本地存的是上一次运行时的 profile id，模型层的配置可能已变过
 * （换版本、删了 profile、连了另一台模型层）。带上一个不存在的 id，
 * 上游会整轮 404，用户表现为"突然发不出消息"，且看不到原因。
 *
 * 策略：**宁可本轮用默认人格，也不要整轮失败**。
 *
 * @param requested 本地选中的 id（空串表示用默认）
 * @param known     模型层真实存在的 id 集合；`null` 表示还没拉到（保守放行）
 */
export function resolvePromptProfileId(
  requested: string,
  known: ReadonlySet<string> | null,
): { profile?: string; stale?: string } {
  const id = requested.trim();
  if (!id) return {};
  // 还没拿到集合（首屏早于 profile 加载）：保守传入，由上游判定
  if (known === null) return { profile: id };
  if (!known.has(id)) return { stale: id };
  return { profile: id };
}

/* ------------------------------------------------------------------ */
/* OmniNexus                                                           */
/* ------------------------------------------------------------------ */

/**
 * 模型条目（`GET /v1/models` 的返回项）。
 *
 * `capabilities.inputModalities` 决定这个模型能不能看图/听音——
 * 发图前必须先查它，否则上游会把图片降级成一句
 * "[Image attachment omitted]"，用户只看到模型"答非所问"。
 */
export interface ModelEntry {
  id: string;
  /** 展示名（缺省用 id） */
  label: string;
  providerKind: "builtin" | "custom";
  providerName: string;
  model: string;
  /** 支持的输入模态 */
  inputModalities: string[];
  contextWindow: number | null;
  available: boolean;
  /** 不可用原因（如 missing_api_key） */
  unavailableReason: string | null;
  verification: string;
}

/** 解析 `/v1/models` 的返回体。 */
export function parseModels(raw: unknown): ModelEntry[] {
  if (!isRecord(raw)) throw new ContractError("omninexus", "models", "不是对象");
  const list = raw.models;
  if (!Array.isArray(list)) {
    throw new ContractError("omninexus", "models", "missing models array");
  }
  const out: ModelEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = str(item.id);
    if (!id) continue;
    const caps = isRecord(item.capabilities) ? item.capabilities : {};
    const modalities = Array.isArray(caps.inputModalities)
      ? caps.inputModalities.filter((m): m is string => typeof m === "string")
      : [];
    out.push({
      id,
      label: str(item.label) || id,
      providerKind: item.providerKind === "custom" ? "custom" : "builtin",
      providerName: str(item.providerName),
      model: str(item.model) || id,
      inputModalities: modalities,
      contextWindow: typeof caps.contextWindow === "number" ? caps.contextWindow : null,
      available: Boolean(item.available),
      unavailableReason: isRecord(item) && typeof item.unavailableReason === "string"
        ? item.unavailableReason
        : null,
      verification: str(item.verification) || "unknown",
    });
  }
  return out;
}

/**
 * 发往模型层的**内容分区**（D-02）。
 *
 * 模型层的 `InboundEvent.parts[]` 原生接受 `{modality, content, metadata}`，
 * 而 provider 层会把 `content` 当 URL 解析：`data:` URI 走 base64 内联分支，
 * 因此**图片必须以 data URI 传入**，不能传回环 URL（模型层取不到）。
 *
 * 文字分区保持纯文本，不要塞 URL。
 */
export interface LLMPart {
  modality: "text" | "image" | "audio";
  content: string;
  metadata?: Record<string, unknown>;
}

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
