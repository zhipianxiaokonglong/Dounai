/**
 * 独立设置窗口。
 *
 * 悬浮窗只保留人格/模型与对话；输入层、模型层、语音层的配置入口，
 * 以及音频输出、音量、勿扰、置顶集中在这里。
 *
 * 密钥约定不变：设置窗口只打开各模块自带的管理界面，不读取、不存储密钥。
 */

import { InputAdapter, LLMAdapter, OutputAdapter } from "../upstream/adapters.js";
import { loadSettings, saveSettings } from "./settings.js";
import { emitAppEvent, invokeApp, openModuleAdmin } from "./bridge.js";

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少必需元素 #${id}`);
  return node as T;
}

const el = {
  refresh: must<HTMLButtonElement>("refresh-status"),
  endpointInput: must<HTMLElement>("endpoint-input"),
  endpointLlm: must<HTMLElement>("endpoint-llm"),
  endpointOutput: must<HTMLElement>("endpoint-output"),
  statusInput: must<HTMLElement>("status-input"),
  statusLlm: must<HTMLElement>("status-llm"),
  statusOutput: must<HTMLElement>("status-output"),
  audioDevice: must<HTMLSelectElement>("audio-device"),
  audioVolume: must<HTMLInputElement>("audio-volume"),
  volumeValue: must<HTMLOutputElement>("volume-value"),
  testAudio: must<HTMLButtonElement>("test-audio"),
  dnd: must<HTMLInputElement>("dnd"),
  alwaysTop: must<HTMLInputElement>("always-top"),
  note: must<HTMLElement>("page-note"),
};

const settings = loadSettings();
const input = new InputAdapter(settings.endpoints.input);
const llm = new LLMAdapter(settings.endpoints.llm);
const output = new OutputAdapter(settings.endpoints.output);

let currentDevice = settings.outputDevice ?? "";
let currentVolume = clampVolume(settings.audioVolume ?? 1);

function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function setNote(message: string, tone: "ok" | "error" | "info" = "info"): void {
  el.note.textContent = message;
  el.note.dataset.tone = tone === "info" ? "" : tone;
}

function setStatus(node: HTMLElement, ok: boolean): void {
  node.dataset.ok = String(ok);
  node.textContent = ok ? "已连接" : "未连接";
  node.title = ok ? "健康检查通过" : "未启动，或该层厂商尚未配置密钥";
}

async function refreshStatus(): Promise<void> {
  el.refresh.disabled = true;
  setStatus(el.statusInput, false);
  setStatus(el.statusLlm, false);
  setStatus(el.statusOutput, false);
  el.statusInput.textContent = "检测中";
  el.statusLlm.textContent = "检测中";
  el.statusOutput.textContent = "检测中";
  const [inputOk, llmOk, outputOk] = await Promise.all([
    input.probe().catch(() => false),
    llm.probe().catch(() => false),
    output.probe().catch(() => false),
  ]);
  setStatus(el.statusInput, inputOk);
  setStatus(el.statusLlm, llmOk);
  setStatus(el.statusOutput, outputOk);
  el.refresh.disabled = false;
}

async function loadAudioDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    el.audioDevice.disabled = true;
    el.audioDevice.replaceChildren(new Option("当前环境不支持设备枚举", ""));
    return;
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "audiooutput",
  );
  el.audioDevice.replaceChildren(new Option("系统默认输出", ""));
  devices.forEach((device, index) => {
    el.audioDevice.appendChild(
      new Option(device.label || `输出设备 ${index + 1}`, device.deviceId),
    );
  });
  const known = Array.from(el.audioDevice.options).some(
    (option) => option.value === currentDevice,
  );
  if (!known) currentDevice = "";
  el.audioDevice.value = currentDevice;
  el.audioDevice.disabled = devices.length === 0;
}

async function broadcastAudio(): Promise<void> {
  settings.outputDevice = currentDevice;
  settings.audioVolume = currentVolume;
  saveSettings(settings);
  await emitAppEvent("dounai://audio-settings", {
    deviceId: currentDevice,
    volume: currentVolume,
  });
}

async function applyAudio(): Promise<void> {
  await broadcastAudio();
  setNote(currentDevice ? "音频设置已应用到悬浮窗。" : "已恢复系统默认输出。", "ok");
}

el.audioDevice.addEventListener("change", () => {
  currentDevice = el.audioDevice.value;
  void applyAudio();
});

function renderVolume(value: number): void {
  currentVolume = clampVolume(value);
  el.audioVolume.value = String(Math.round(currentVolume * 100));
  el.volumeValue.textContent = `${Math.round(currentVolume * 100)}%`;
}

el.audioVolume.addEventListener("input", () => {
  renderVolume(Number(el.audioVolume.value) / 100);
});
el.audioVolume.addEventListener("change", () => {
  void applyAudio();
});

navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void loadAudioDevices();
});

/* ------------------------------------------------------------------ */
/* 测试音：只用于确认所选输出设备，不经过悬浮窗口的播放链路              */
/* ------------------------------------------------------------------ */

function createToneUrl(): string {
  const rate = 16_000;
  const seconds = 0.6;
  const freq = 660;
  const count = Math.floor(rate * seconds);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i += 1) {
    const sample = Math.sin((2 * Math.PI * freq * i) / rate) * 0.25 * 32767;
    view.setInt16(44 + i * 2, sample, true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

type SinkCapableAudio = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

async function playTestTone(): Promise<void> {
  const url = createToneUrl();
  const audio = new Audio(url) as SinkCapableAudio;
  audio.volume = currentVolume;
  try {
    if (audio.setSinkId) await audio.setSinkId(currentDevice || "");
    await audio.play();
    setNote("测试音已通过当前输出设备播放。", "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setNote(`测试音播放失败：${message}`, "error");
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

el.testAudio.addEventListener("click", () => {
  void playTestTone();
});

/* ------------------------------------------------------------------ */
/* 模块管理入口                                                        */
/* ------------------------------------------------------------------ */

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-admin]"))) {
  button.addEventListener("click", () => {
    const moduleId = button.dataset.admin ?? "";
    void openModuleAdmin(moduleId)
      .then(() => setNote(`已在系统浏览器打开 ${moduleId} 的管理界面。`, "ok"))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setNote(`打不开 ${moduleId} 的管理界面：${message}`, "error");
      });
  });
}

/* ------------------------------------------------------------------ */
/* 桌面行为                                                            */
/* ------------------------------------------------------------------ */

async function loadDesktopSettings(): Promise<void> {
  try {
    const native = await invokeApp<{ do_not_disturb: boolean; always_on_top: boolean }>(
      "get_settings",
    );
    el.dnd.checked = Boolean(native.do_not_disturb);
    el.alwaysTop.checked = Boolean(native.always_on_top);
  } catch {
    el.dnd.checked = Boolean(settings.doNotDisturb);
    el.alwaysTop.checked = true;
  }
}

el.dnd.addEventListener("change", () => {
  settings.doNotDisturb = el.dnd.checked;
  saveSettings(settings);
  void invokeApp("set_do_not_disturb", { enabled: el.dnd.checked })
    .then(() => setNote(el.dnd.checked ? "勿扰模式已开启。" : "勿扰模式已关闭。", "ok"))
    .catch(() => setNote("无法修改勿扰模式；请确认悬浮窗仍在运行。", "error"));
});

el.alwaysTop.addEventListener("change", () => {
  void invokeApp("set_always_on_top", { enabled: el.alwaysTop.checked })
    .then(() => setNote(el.alwaysTop.checked ? "悬浮窗已置顶。" : "悬浮窗已取消置顶。", "ok"))
    .catch(() => setNote("无法修改置顶状态；请确认悬浮窗仍在运行。", "error"));
});

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

el.endpointInput.textContent = settings.endpoints.input;
el.endpointLlm.textContent = settings.endpoints.llm;
el.endpointOutput.textContent = settings.endpoints.output;
el.refresh.addEventListener("click", () => void refreshStatus());

renderVolume(currentVolume);
void loadAudioDevices();
void loadDesktopSettings();
void refreshStatus();
