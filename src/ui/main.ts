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
import { loadSettings } from "./settings.js";
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

el.avatarHost.addEventListener("click", () => {
  if (el.panel.hidden) openPanel();
  else closePanel();
});

el.close.addEventListener("click", closePanel);

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
  appendUserBubble(text);
  currentBubble = null;

  try {
    const snapshot = await orchestrator.submit(text);
    syncAudio(snapshot);
    if (!snapshot.audioUrl) orchestrator.notifyTextSettled();
  } finally {
    busy = false;
    if (lastSnapshot) renderControls(lastSnapshot);
  }
}

function appendUserBubble(text: string): void {
  const node = document.createElement("div");
  node.className = "bubble bubble--user";
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
  if (health.input && health.llm) {
    openPanel();
  } else {
    showBadge("部分服务未连接", "error");
  }
})();
