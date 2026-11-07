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

/**
 * 情绪标签（Emotion contract v2）。
 *
 * 12 类，与 OmniNexus `core/emotions.py::PUBLIC_EMOTION_LABELS` 及
 * MoodVoice `config/emotion_styles.yaml` 完全一致。
 *
 * 此前这里是 9 类（含 fear/confusion/gratitude、缺 comfort/calm/apology），
 * 那份口径已被两家上游废弃——`fear/confusion/gratitude` 现在是
 * **旧版别名**（见 LEGACY_EMOTION_ALIASES），由上游映射到新类。
 */
export type Emotion =
  | "neutral"
  | "joy"
  | "excitement"
  | "comfort"
  | "tenderness"
  | "calm"
  | "sadness"
  | "apology"
  | "encouragement"
  | "surprise"
  | "frustration"
  | "anger";

export type ContentType = "text" | "code" | "list" | "table" | "json" | "mixed";
export type Intent = "reply" | "tool" | "linkage";

const EMOTIONS: readonly Emotion[] = [
  "neutral",
  "joy",
  "excitement",
  "comfort",
  "tenderness",
  "calm",
  "sadness",
  "apology",
  "encouragement",
  "surprise",
  "frustration",
  "anger",
];

/**
 * 旧版情绪别名（与 OmniNexus `LEGACY_EMOTION_ALIASES` 保持一致）。
 *
 * 旧客户端可能发这些值；上游会映射到新类。消费方也应照做，
 * 否则会把**合法的旧值**误判为越界。
 */
const LEGACY_EMOTION_ALIASES: Readonly<Record<string, Emotion>> = {
  fear: "sadness",
  confusion: "frustration",
  gratitude: "joy",
};
const CONTENT_TYPES: readonly ContentType[] = ["text", "code", "list", "table", "json", "mixed"];
const INTENTS: readonly Intent[] = ["reply", "tool", "linkage"];

const isOneOf = <T extends string>(list: readonly T[], v: string): v is T =>
  (list as readonly string[]).includes(v);

/**
 * 把上游情绪标签归一化到契约内的 9 类。
 *
 * 上游可能返回契约外的值（例如模型层 v2 的 12 类情绪）。
 * 静默强转会让类型撒谎，抛错又会让整条回合失败，因此落到 `neutral`，
 * 并通过 `unknown` 标记告知调用方"上游越界"。
 */
export function normalizeEmotion(raw: unknown): { value: Emotion; unknown: boolean } {
  const s = str(raw, "neutral");
  if (isOneOf(EMOTIONS, s)) return { value: s, unknown: false };
  // 旧版别名不算越界：按上游同一张表映射
  const alias = LEGACY_EMOTION_ALIASES[s];
  if (alias) return { value: alias, unknown: false };
  return { value: "neutral", unknown: true };
}

export function normalizeContentType(raw: unknown): { value: ContentType; unknown: boolean } {
  const s = str(raw, "text");
  return isOneOf(CONTENT_TYPES, s)
    ? { value: s, unknown: false }
    : { value: "text", unknown: true };
}

export function normalizeIntent(raw: unknown): { value: Intent; unknown: boolean } {
  const s = str(raw, "reply");
  return isOneOf(INTENTS, s)
    ? { value: s, unknown: false }
    : { value: "reply", unknown: true };
}

export interface OutputTags {
  emotion: Emotion;
  type: ContentType;
  intent: Intent;
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
      // 上游未给标签时用中性值，避免 UI 出现空白状态；
      // 越界值（如模型层 v2 的 12 类情绪）由归一化函数收敛到契约内
      emotion: normalizeEmotion(tagsRaw.emotion).value,
      type: normalizeContentType(tagsRaw.type).value,
      intent: normalizeIntent(tagsRaw.intent).value,
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

/**
 * 按错误码推断「是否值得重试」。
 *
 * 为什么需要：输入层与语音层的错误体**不带 `retryable` 字段**
 * （只有模型层带）。缺省成 `false` 会把"厂商临时故障"也判成不可重试，
 * 而缺省成 `true` 又会让"参数错误"被无意义地重试。
 *
 * 因此按语义分三类：
 * - 临时性（网络/厂商/超时/冲突）→ 可重试
 * - 参数性（输入非法/超限/不支持）→ 不可重试
 * - 权限性（鉴权/隐私/同意）→ 不可重试
 */
const RETRYABLE_CODES = new Set([
  // 临时性故障
  "provider_unavailable",
  "timeout",
  "internal_error",
  "conflict",
  "cache_write_failed",
  "cache_error",
  "unknown_provider",
  "provider_error",
  "connection_error",
  // 模型层大写码（有 retryable 时以上游为准，这里只作兜底）
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_TIMEOUT_RETRY",
  "PROVIDER_ERROR",
  "PROVIDER_BAD_RESPONSE",
  "INTERNAL_ERROR",
  "ALL_PROVIDERS_FAILED",
]);

export function parseUpstreamError(raw: unknown): UpstreamError {
  const root = isRecord(raw) ? raw : {};
  const error = isRecord(root.error) ? root.error : root;
  const code = str(error.code, "UNKNOWN");
  return {
    code,
    message: str(error.message),
    // 上游明确给了就用它；没给则按码推断
    retryable: typeof error.retryable === "boolean"
      ? error.retryable
      : RETRYABLE_CODES.has(code),
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
