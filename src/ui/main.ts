/**
 * UI 主入口：把编排器的快照渲染成悬浮窗。
 *
 * 性能要点（docs/architecture.md §7.1）：
 *  - 流式文本用 requestAnimationFrame 合并写入，单帧只 patch 一次；
 *  - 音频口型由 audio.currentTime 驱动，不用定时器估算，避免音画不同步；
 *  - 隐藏时暂停动画与电平采样。
 */

import { Orchestrator, type TurnSnapshot } from "../orchestrator/index.js";
import {
  DEFAULT_ENDPOINTS,
  InputAdapter,
  LLMAdapter,
  OutputAdapter,
  resolveAudioUrl,
} from "../upstream/adapters.js";
import { createAvatar, registerAvatar, DEFAULT_AVATAR_ID, type AvatarState } from "../avatar/types.js";
import { LogoAvatarRenderer } from "../avatar/renderers/logo.js";
import { loadSettings, saveSettings } from "./settings.js";
import { resolvePromptProfileId, type ModelEntry } from "../contracts/index.js";
import { mountTrayBridge } from "./bridge.js";
import { detectRuntime, resolveEndpoints } from "./runtime.js";

registerAvatar("logo", () => new LogoAvatarRenderer());

const el = {
  app: must<HTMLElement>("app"),
  avatarHost: must<HTMLElement>("avatar-host"),
  badge: must<HTMLElement>("badge"),
  badgeDot: must<HTMLElement>("badge-dot"),
  badgeText: must<HTMLElement>("badge-text"),
  panel: must<HTMLElement>("panel"),
  stream: must<HTMLElement>("stream"),
  emptyHint: must<HTMLElement>("empty-hint"),
  notice: must<HTMLElement>("notice"),
  composer: must<HTMLFormElement>("composer"),
  input: must<HTMLInputElement>("input"),
  send: must<HTMLButtonElement>("btn-send"),
  close: must<HTMLButtonElement>("btn-close"),
  btnNewSession: must<HTMLButtonElement>("btn-new-session"),
  voice: must<HTMLAudioElement>("voice"),
  modelHint: must<HTMLElement>("model-hint"),
  modelSelect: must<HTMLSelectElement>("model-select"),
  layerStatus: must<HTMLElement>("layer-status"),
  // 结构图要求的三路输入入口 + 提示词切换入口
  btnImage: must<HTMLButtonElement>("btn-image"),
  btnVoice: must<HTMLButtonElement>("btn-voice"),
  filePicker: must<HTMLInputElement>("file-picker"),
  promptSelect: must<HTMLSelectElement>("prompt-select"),
};

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少必需元素 #${id}`);
  return node as T;
}

const settings = loadSettings();
const runtime = detectRuntime();
const endpoints = resolveEndpoints(settings.endpoints);

const adapters = {
  input: new InputAdapter(endpoints.input),
  llm: new LLMAdapter(endpoints.llm),
  output: new OutputAdapter(endpoints.output),
};

let lastSnapshot: TurnSnapshot | null = null;
let pendingText = "";
let rafHandle = 0;
let currentBubble: HTMLElement | null = null;
let busy = false;
/** 当前选中的提示词配置 ID（空字符串 = 用模型层默认） */
let currentPromptProfile = settings.promptProfile ?? "";
/** 模型清单缓存（供发图前能力检查） */
let knownModels: ModelEntry[] = [];

/**
 * 当前模型层**实际存在**的提示词配置 ID 集合（D-03）。
 *
 * 为什么需要它：本地存的是上一次运行时的 profile id，模型层的配置可能已经变过
 * （换版本、删了 profile、连了另一台模型层）。提交时若带上一个不存在的 id，
 * 上游会整轮 404，用户表现为"突然发不出消息"。
 */
let knownPromptProfiles: Set<string> | null = null;

/**
 * 会话 ID（D-01）。
 *
 * 为什么必须由组装层自己持有：输入层收了 `session_id` 但不回传，
 * 模型层收不到就静默新建会话——整条链路没有任何一处能保证"同一会话"。
 * 所以本地持久化一份，每次提交都带上。
 *
 * 必须是 UUID：**模型层**的 `InboundEvent.session_id` 是 `uuid.UUID` 类型，
 * 传非 UUID 会直接判 422（整轮失败）。
 * 输入层（`str | None`）与语音层（`str`，默认空串、最长 128）都不限格式，
 * 但为了让一个 ID 三层通用，这里统一生成 UUID。
 */
const SESSION_KEY = "dounai.session_id";

function newSessionId(): string {
  // crypto.randomUUID 在 WebView2 里可用；退化路径手搓 v4 形如 UUID
  const maybe = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (typeof maybe === "function") return maybe.call(globalThis.crypto);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadSessionId(): string {
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored && UUID_RE.test(stored)) return stored;
  } catch {
    // localStorage 不可用时退化为内存会话，不阻断对话
  }
  const fresh = newSessionId();
  try {
    localStorage.setItem(SESSION_KEY, fresh);
  } catch {
    // 同上
  }
  return fresh;
}

let sessionId = loadSessionId();

const orchestrator = new Orchestrator(adapters, {
  onSnapshot: (snapshot) => {
    lastSnapshot = snapshot;
    scheduleRender(snapshot);
  },
});

/* ------------------------------------------------------------------ */
/* 渲染：合并到单帧                                                    */
/* ------------------------------------------------------------------ */

function scheduleRender(snapshot: TurnSnapshot): void {
  pendingText = snapshot.text;
  if (rafHandle) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0;
    render(lastSnapshot!, pendingText);
  });
}

function render(snapshot: TurnSnapshot, text: string): void {
  const avatarState = toAvatarState(snapshot.state);
  avatar?.setState(avatarState);
  avatar?.setEmotion(snapshot.emotion);

  el.app.dataset.state = snapshot.state;
  renderBadge(snapshot);
  renderWelcomeHint(snapshot.health);
  renderLayerStatus(snapshot);
  renderStream(snapshot, text);
  renderNotice(snapshot);
  renderControls(snapshot);
}

function renderBadge(snapshot: TurnSnapshot): void {
  const { health } = snapshot;
  if (!health.input && !health.llm) {
    showBadge("服务未连接", "error");
    return;
  }
  if (!health.input) {
    showBadge("输入服务未连接", "error");
    return;
  }
  if (!health.llm) {
    showBadge("模型服务未连接", "error");
    return;
  }
  if (!health.output) {
    showBadge("语音不可用", "warn");
    return;
  }
  hideBadge();
}

function showBadge(text: string, tone: "ok" | "warn" | "error"): void {
  el.badge.hidden = false;
  el.badge.dataset.tone = tone;
  el.badgeText.textContent = text;
}

function hideBadge(): void {
  el.badge.hidden = true;
}

/**
 * 降级欢迎态：无上游可用时，空态区改成可操作的排障指引。
 *
 * 任务书要求「总装壳可独立启动（无模块时进入降级欢迎态），不得白屏崩溃」。
 * 只显示一个徽标是不够的——用户面对一个发不出消息的输入框，
 * 会以为是自己操作错了。这里把「缺什么、怎么办」直接写在对话区。
 */
function renderWelcomeHint(health: TurnSnapshot["health"]): void {
  const missing: string[] = [];
  if (!health.input) missing.push("输入层");
  if (!health.llm) missing.push("模型层");
  if (!health.output) missing.push("语音层");

  // 全部就绪：显示正常的开场白
  if (missing.length === 0) {
    el.emptyHint.textContent = "说点什么吧，我在。";
    el.emptyHint.dataset.degraded = "false";
    return;
  }

  // 语音层缺失不算致命：对话仍可用，只是没有声音
  const blocking = !health.input || !health.llm;
  const lines: string[] = [];
  lines.push(blocking ? "上游服务还没连接上。" : "文字对话可用，语音暂不可用。");
  lines.push("");
  lines.push(`未连接：${missing.join("、")}`);
  lines.push("");
  lines.push("请在对应仓库启动服务后重试：");
  if (!health.input) lines.push("  · 输入层  :8101  dounai-input serve");
  if (!health.llm) lines.push("  · 模型层  :8102  python -m omninexus");
  if (!health.output) lines.push("  · 语音层  :8103  python -m emotional_tts serve");
  lines.push("");
  lines.push("模型没配好也会导致这里显示未连接，");
  lines.push("详见 docs/model-setup.md（如何设置模型）。");

  el.emptyHint.textContent = lines.join("\n");
  el.emptyHint.dataset.degraded = blocking ? "true" : "false";
}

function renderStream(snapshot: TurnSnapshot, text: string): void {
  if (!text) {
    el.emptyHint.hidden = false;
    return;
  }
  el.emptyHint.hidden = true;

  if (!currentBubble) {
    currentBubble = document.createElement("div");
    currentBubble.className = "bubble bubble--assistant bubble--streaming";
    const body = document.createElement("div");
    body.className = "bubble__body";
    currentBubble.appendChild(body);
    el.stream.appendChild(currentBubble);
  }

  const body = currentBubble.firstElementChild as HTMLElement;
  // textContent 而非 innerHTML：上游文本一律按纯文本渲染，防 XSS
  if (body.textContent !== text) body.textContent = text;

  if (snapshot.state === "talking" && !snapshot.audioUrl) {
    currentBubble.classList.add("bubble--streaming");
  } else {
    currentBubble.classList.remove("bubble--streaming");
  }

  if (snapshot.contentType === "code") currentBubble.classList.add("bubble--code");

  el.stream.scrollTop = el.stream.scrollHeight;
}

/**
 * 渲染三层连接状态。
 *
 * 只显示"哪层通、哪层不通"以及去哪里配置——**不展示也不收集任何密钥**。
 * 密钥由启动器的「厂商」页写入，启动模块时以环境变量注入上游，
 * 悬浮窗这一侧根本拿不到密钥（见 launcher 的 vendor_keys 设计）。
 */
function renderLayerStatus(snapshot: TurnSnapshot): void {
  const layers: Array<[string, boolean]> = [
    ["输入", snapshot.health.input],
    ["模型", snapshot.health.llm],
    ["语音", snapshot.health.output],
  ];
  el.layerStatus.hidden = false;
  el.layerStatus.replaceChildren();

  for (const [name, ok] of layers) {
    const chip = document.createElement("span");
    chip.className = "panel__layer-chip";
    chip.dataset.ok = String(ok);
    chip.textContent = `${name} ${ok ? "✓" : "✗"}`;
    chip.title = ok
      ? `${name}层已连接`
      : `${name}层未连接：可能未启动，或该层厂商未配置密钥`;
    el.layerStatus.appendChild(chip);
  }

  const down = layers.filter(([, ok]) => !ok).map(([n]) => n);
  if (down.length > 0) {
    const hint = document.createElement("span");
    hint.className = "panel__layers-hint";
    hint.textContent =
      `${down.join("、")}不可用。请到启动器的「厂商」页配置厂商密钥并重启对应模块` +
      "（本窗口不保存密钥）。";
    el.layerStatus.appendChild(hint);
  }
}

function renderNotice(snapshot: TurnSnapshot): void {
  if (!snapshot.notice) {
    el.notice.hidden = true;
    el.notice.textContent = "";
    return;
  }
  el.notice.hidden = false;
  el.notice.textContent = snapshot.notice;
  el.notice.dataset.tone = snapshot.state === "degraded" ? "error" : "warn";
}

function renderControls(snapshot: TurnSnapshot): void {
  const canSend = snapshot.health.input && snapshot.health.llm && !busy;
  el.input.disabled = !canSend;
  el.send.disabled = !canSend;
  el.input.placeholder = !snapshot.health.input
    ? "输入服务未连接"
    : !snapshot.health.llm
      ? "模型服务未连接"
      : "输入消息…";
}

function toAvatarState(state: TurnSnapshot["state"]): AvatarState {
  switch (state) {
    case "wakeup":
      return "wakeup";
    case "talking":
      return "talking";
    case "emotion":
      return "emotion";
    case "degraded":
      return "degraded";
    default:
      return "default";
  }
}

/* ------------------------------------------------------------------ */
/* 形象层                                                              */
/* ------------------------------------------------------------------ */

let avatar = createAvatar(settings.avatarRenderer || DEFAULT_AVATAR_ID);
if (!avatar) avatar = createAvatar(DEFAULT_AVATAR_ID);

const avatarCtx = {
  getState: () => toAvatarState(lastSnapshot?.state ?? "default"),
  pulse: (kind: "wakeup" | "ack") => {
    avatar?.setState(kind === "wakeup" ? "wakeup" : "talking");
  },
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};

if (avatar) {
  void avatar.mount(el.avatarHost, avatarCtx);
  avatar.setTheme({
    accent: settings.theme.accent,
    surface: settings.theme.surface,
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  });
}

/* ------------------------------------------------------------------ */
/* 音频：以 currentTime 为唯一时钟                                      */
/* ------------------------------------------------------------------ */

let levelRaf = 0;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;

function ensureAnalyser(): void {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    sourceNode = audioCtx.createMediaElementSource(el.voice);
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch {
    // 无法建立音频分析时退化为「无口型」播放，不影响语音本身
    audioCtx = null;
    analyser = null;
  }
}

function startSpeakingLoop(): void {
  if (levelRaf) return;
  ensureAnalyser();
  const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;

  const tick = (): void => {
    if (!analyser || !data) {
      levelRaf = 0;
      return;
    }
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i]!;
    const level = Math.min(1, sum / (data.length * 128));
    avatar?.setSpeakingLevel(level);
    levelRaf = requestAnimationFrame(tick);
  };
  levelRaf = requestAnimationFrame(tick);
}

function stopSpeakingLoop(): void {
  if (levelRaf) cancelAnimationFrame(levelRaf);
  levelRaf = 0;
  avatar?.setSpeakingLevel(0);
}

el.voice.addEventListener("ended", () => {
  stopSpeakingLoop();
  orchestrator.notifyAudioEnded();
});

el.voice.addEventListener("error", () => {
  stopSpeakingLoop();
  // 音频失败不应打断对话：直接回到默认态，文本已可见
  orchestrator.notifyTextSettled();
});

function playAudio(url: string): void {
  el.voice.src = url;
  const playPromise = el.voice.play();
  if (playPromise) {
    playPromise
      .then(() => startSpeakingLoop())
      .catch(() => {
        // 自动播放被浏览器策略拦截：静音标记，文本继续可读
        stopSpeakingLoop();
        orchestrator.notifyTextSettled();
      });
  }
}

let lastAudioUrl: string | null = null;
function syncAudio(snapshot: TurnSnapshot): void {
  const url = snapshot.audioUrl;
  if (url === lastAudioUrl) return;
  lastAudioUrl = url;
  if (url) playAudio(url);
  else {
    el.voice.pause();
    el.voice.removeAttribute("src");
    stopSpeakingLoop();
  }
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

function openPanel(): void {
  el.panel.hidden = false;
  el.input.focus();
  // 展开时刷新一次三层连接状态：
  // 状态条是上一次 probe 的结果，长时间收起后会过期（上游可能已被停掉）。
  // probe() 内部会 patch 快照并触发重渲染，无需在此手动 render。
  void orchestrator.probe();
}

/**
 * 收起面板（D-04）。
 *
 * 只收起窗口，**不清对话**：用户"收起来再展开"应该还能看见刚才的对话。
 * 清空语义由「新对话」按钮承担——那才是一次明确的上下文重置。
 */
function closePanel(): void {
  el.panel.hidden = true;
  currentBubble = null;
}

/** 新对话：重置上下文并换一个会话 ID（D-04 + D-01）。 */
function startNewSession(): void {
  currentBubble = null;
  el.stream.replaceChildren(el.emptyHint);
  orchestrator.reset();
  // 换新会话 ID：否则模型层仍会把新对话接到旧上下文里
  sessionId = newSessionId();
  try {
    localStorage.setItem(SESSION_KEY, sessionId);
  } catch {
    // 存不进就只用内存值
  }
  renderControls(lastSnapshot ?? idleSnapshot());
}

/**
 * 形象层点击 vs 拖动。
 *
 * 为什么不用 `click`：Tauri 的拖动区在 mousedown 时就会调用
 * `stopImmediatePropagation()` 启动系统拖拽，后续 click 事件被吞掉，
 * 于是「点 logo 展开面板」会失效。
 *
 * 这里改用 pointerdown/pointerup 自行判定：
 *  - 按下与抬起之间位移小于 5px 且耗时短于 400ms → 视为点击；
 *  - 否则视为拖动，不触发面板切换。
 */
let pointerStart: { x: number; y: number; t: number } | null = null;

el.avatarHost.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  pointerStart = { x: event.clientX, y: event.clientY, t: Date.now() };
});

el.avatarHost.addEventListener("pointerup", (event) => {
  if (event.button !== 0 || !pointerStart) return;
  const dx = Math.abs(event.clientX - pointerStart.x);
  const dy = Math.abs(event.clientY - pointerStart.y);
  const elapsed = Date.now() - pointerStart.t;
  pointerStart = null;

  // 位移或时长超阈值 → 是拖动，不是点击
  if (dx > 5 || dy > 5 || elapsed > 400) return;

  if (el.panel.hidden) openPanel();
  else closePanel();
});

el.modelSelect.addEventListener("change", () => {
  const model = el.modelSelect.value;
  settings.model = model;
  saveSettings(settings);
  updateModelHint();
});

el.close.addEventListener("click", closePanel);
el.btnNewSession.addEventListener("click", () => {
  if (!confirm("开始新对话？\n\n当前对话会从界面上清空，助手也会忘记之前的上下文。")) return;
  startNewSession();
});

/* 图像入口：点击 → 选文件 → 交给输入层 */
el.btnImage.addEventListener("click", () => el.filePicker.click());
el.filePicker.addEventListener("change", () => {
  const file = el.filePicker.files?.[0];
  el.filePicker.value = "";
  if (file) void sendImage(file);
});

/* 语音入口：点击开始录音，再点结束并上传 */
el.btnVoice.addEventListener("click", () => void toggleRecording());

/* 提示词切换：直接作用于下一轮（模型层支持每轮覆盖） */
el.promptSelect.addEventListener("change", () => {
  currentPromptProfile = el.promptSelect.value;
  saveSettings({ ...settings, promptProfile: currentPromptProfile });
});

/** 拉取提示词配置列表；失败时静默保留「默认」一项，不影响对话。 */
async function loadPromptProfiles(): Promise<void> {
  const profiles = await adapters.llm.listPromptProfiles();
  // D-03：记下"真实存在"的集合，供提交前校验
  knownPromptProfiles = new Set(profiles.map((profile) => profile.id));
  if (profiles.length === 0) {
    el.promptSelect.disabled = true;
    el.promptSelect.title = "模型层未提供提示词配置";
    return;
  }
  el.promptSelect.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name || profile.id;
    if (profile.id === currentPromptProfile) option.selected = true;
    el.promptSelect.appendChild(option);
  }
  el.promptSelect.disabled = false;
  // 若保存的配置已不存在，回落到第一个可用项
  if (!profiles.some((profile) => profile.id === currentPromptProfile)) {
    currentPromptProfile = profiles[0]?.id ?? "";
    el.promptSelect.value = currentPromptProfile;
  }
}

/**
 * 解析本轮真正要用的提示词配置（D-03）。
 *
 * 三条规则：
 * 1. 没选（空串）→ 不传，用模型层默认；
 * 2. 选的值不在已知集合里 → **不传**并清空本地记录，同时提示用户；
 * 3. 还没拿到集合（首屏早于 profile 加载）→ 保守传入，由上游判定。
 *
 * 宁可这轮用默认人格，也不要让整轮 404 失败。
 */
function resolvePromptProfile(): string | undefined {
  const decision = resolvePromptProfileId(currentPromptProfile, knownPromptProfiles);
  if (decision.stale) {
    currentPromptProfile = "";
    saveSettings({ ...settings, promptProfile: "" });
    el.promptSelect.value = "";
    el.notice.hidden = false;
    el.notice.textContent = `提示词配置「${decision.stale}」已不存在，本轮改用默认人格。`;
    el.notice.dataset.tone = "warn";
    return undefined;
  }
  return decision.profile;
}

/** 当前选中的模型是否支持看图（决定发图是否可行）。 */
function currentModelSupportsImage(): boolean {
  const selected = el.modelSelect.value || settings.model || "";
  if (!selected) {
    // 未显式选择：只有"全部模型都不支持"时才算不支持
    if (knownModels.length === 0) return true;
    return knownModels.some((m) => m.inputModalities.includes("image"));
  }
  const entry = knownModels.find((m) => m.id === selected);
  if (!entry) return true; // 未知模型不拦（交由上游判定）
  return entry.inputModalities.includes("image");
}

/** 读取模型清单并渲染下拉。 */
async function loadModels(): Promise<void> {
  try {
    knownModels = await adapters.llm.listModels();
  } catch {
    // 模型层不可用：保留默认项，不阻断对话
    knownModels = [];
    el.modelSelect.replaceChildren();
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "模型层不可用";
    el.modelSelect.appendChild(opt);
    el.modelSelect.disabled = true;
    el.modelHint.textContent = "模型层不可用";
    return;
  }

  el.modelSelect.disabled = false;
  el.modelSelect.replaceChildren();

  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "自动选择模型";
  el.modelSelect.appendChild(auto);

  for (const m of knownModels) {
    const opt = document.createElement("option");
    opt.value = m.id;
    // 标注可用性与视觉能力，用户一眼能看出能不能发图
    const marks: string[] = [];
    if (!m.available) marks.push("不可用");
    if (m.inputModalities.includes("image")) marks.push("可看图");
    if (m.providerKind === "custom") marks.push("自定义");
    opt.textContent = `${m.label}${marks.length ? "（" + marks.join("、") + "）" : ""}`;
    opt.disabled = !m.available;
    if (m.id === settings.model) opt.selected = true;
    el.modelSelect.appendChild(opt);
  }

  updateModelHint();
}

function updateModelHint(): void {
  const selected = el.modelSelect.value;
  const entry = knownModels.find((m) => m.id === selected);
  if (!entry) {
    el.modelHint.textContent = selected ? `模型：${selected}` : "自动选择模型";
    return;
  }
  const vision = entry.inputModalities.includes("image") ? "可看图" : "不支持图片";
  el.modelHint.textContent = `${entry.providerName || "?"} · ${vision}`;
}

el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void send(el.input.value);
});

async function send(raw: string): Promise<void> {
  const text = raw.trim();
  if (!text || busy) return;

  busy = true;
  el.input.value = "";
  renderControls(lastSnapshot ?? idleSnapshot());
  appendUserBubble(text, "text");
  currentBubble = null;

  try {
    const snapshot = await orchestrator.submit(
      { kind: "text", text },
      { sessionId, promptProfile: resolvePromptProfile(), model: el.modelSelect.value || undefined },
    );
    syncAudio(snapshot);
    if (!snapshot.audioUrl) orchestrator.notifyTextSettled();
  } finally {
    busy = false;
    if (lastSnapshot) renderControls(lastSnapshot);
  }
}

/* ------------------------------------------------------------------ */
/* 图像输入（结构图：图像输入 → 输入层，受控媒体 URL）                   */
/* ------------------------------------------------------------------ */

async function sendImage(file: File): Promise<void> {
  if (busy) return;
  busy = true;
  renderControls(lastSnapshot ?? idleSnapshot());
  appendUserBubble(`🖼 图片：${file.name || "粘贴的图片"}`, "image");
  currentBubble = null;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const snapshot = await orchestrator.submit(
      {
        kind: "image",
        bytes,
        filename: file.name || undefined,
        mime: file.type || undefined,
        // 发图前先查当前模型能力（不支持就不发，避免上游降级成"答非所问"）
        modelSupportsImage: currentModelSupportsImage(),
      },
      { sessionId, promptProfile: resolvePromptProfile(), model: el.modelSelect.value || undefined },
    );
    syncAudio(snapshot);
    if (!snapshot.audioUrl) orchestrator.notifyTextSettled();
  } catch (error) {
    showLocalError(error);
  } finally {
    busy = false;
    if (lastSnapshot) renderControls(lastSnapshot);
  }
}

/* ------------------------------------------------------------------ */
/* 语音输入（结构图：语音输入 → 声纹/ASR → 输入层）                     */
/* ------------------------------------------------------------------ */

let recorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recording = false;

async function toggleRecording(): Promise<void> {
  if (recording) {
    recorder?.stop();
    return;
  }
  if (busy) return;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    showLocalError(error, "无法访问麦克风，请检查系统权限。");
    return;
  }

  recordedChunks = [];
  // WebM/Opus 是 Chromium 下最稳的组合，输入层明确接受 WebM
  recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    recording = false;
    stream.getTracks().forEach((track) => track.stop());
    el.btnVoice.dataset.recording = "false";
    const blob = new Blob(recordedChunks, { type: "audio/webm" });
    recordedChunks = [];
    if (blob.size > 0) void sendAudio(blob);
  });

  recorder.start();
  recording = true;
  el.btnVoice.dataset.recording = "true";
}

async function sendAudio(blob: Blob): Promise<void> {
  busy = true;
  renderControls(lastSnapshot ?? idleSnapshot());
  appendUserBubble("🎙 语音消息", "audio");
  currentBubble = null;

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const snapshot = await orchestrator.submit(
      { kind: "audio", bytes, filename: "voice.webm", mime: "audio/webm", language: "zh" },
      { sessionId, promptProfile: resolvePromptProfile(), model: el.modelSelect.value || undefined },
    );
    syncAudio(snapshot);
    if (!snapshot.audioUrl) orchestrator.notifyTextSettled();
  } catch (error) {
    showLocalError(error);
  } finally {
    busy = false;
    if (lastSnapshot) renderControls(lastSnapshot);
  }
}

function showLocalError(error: unknown, fallback = "操作失败，请重试。"): void {
  const message = error instanceof Error && error.message ? error.message : fallback;
  el.notice.hidden = false;
  el.notice.textContent = fallback === message ? message : `${fallback}（${message}）`;
  el.notice.dataset.tone = "error";
}

function appendUserBubble(text: string, modality: "text" | "image" | "audio"): void {
  const node = document.createElement("div");
  node.className = "bubble bubble--user";
  node.dataset.modality = modality;
  node.textContent = text;
  el.stream.appendChild(node);
  el.emptyHint.hidden = true;
  el.stream.scrollTop = el.stream.scrollHeight;
}

function idleSnapshot(): TurnSnapshot {
  return {
    state: "default",
    text: "",
    emotion: null,
    contentType: "text",
    intent: "reply",
    audioUrl: null,
    notice: null,
    health: { input: true, llm: true, output: true },
    degraded: false,
    modality: "text",
  };
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

mountTrayBridge({
  onTogglePanel: () => (el.panel.hidden ? openPanel() : closePanel()),
  onWake: () => {
    orchestrator.wake();
    openPanel();
  },
  onDndChanged: (enabled) => {
    el.app.dataset.dnd = String(enabled);
    if (enabled) {
      el.voice.pause();
      stopSpeakingLoop();
    }
  },
  onQuit: () => window.close(),
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.panel.hidden) closePanel();
});

document.addEventListener("visibilitychange", () => {
  // 隐藏时停止电平采样，避免后台耗电
  if (document.hidden) stopSpeakingLoop();
  else if (!el.voice.paused) startSpeakingLoop();
});

el.modelHint.textContent = settings.model ? `模型：${settings.model}` : "自动选择模型";

void (async () => {
  const health = await orchestrator.probe();
  if (lastSnapshot) render(lastSnapshot, "");

  // 无论上游是否就绪都展开面板：
  //  - 就绪 → 正常对话；
  //  - 未就绪 → 展示降级欢迎态里的排障指引（任务书 §4.4「不得白屏」）。
  // 之前降级时只显示徽标、面板保持收起，用户只能看到一个 logo，
  // 不知道发生了什么，也不知道该做什么。
  openPanel();
  if (!health.input || !health.llm) {
    showBadge("部分服务未连接", "error");
  }
})();
