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
  voice: must<HTMLAudioElement>("voice"),
  modelHint: must<HTMLElement>("model-hint"),
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
}

function closePanel(): void {
  el.panel.hidden = true;
  currentBubble = null;
  el.stream.replaceChildren(el.emptyHint);
  orchestrator.reset();
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

el.close.addEventListener("click", closePanel);

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
      { promptProfile: currentPromptProfile || undefined },
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
      },
      { promptProfile: currentPromptProfile || undefined },
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
      { promptProfile: currentPromptProfile || undefined },
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
