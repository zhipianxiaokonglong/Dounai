/**
 * 渲染层 ↔ 主进程的桥。
 *
 * 设计目标：让 UI 能在**浏览器里独立跑**（`npm run dev` 无需 Tauri），
 * 因此这里对 Tauri API 做能力探测，不存在时退化为纯前端行为。
 */

export interface TrayBridge {
  onTogglePanel(): void;
  onWake(): void;
  onDndChanged(enabled: boolean): void;
  onQuit(): void;
}

interface TauriInvoke {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface TauriEventApi {
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;
}

interface TauriGlobal {
  /** Tauri 2：invoke 位于 `core` 命名空间（`window.__TAURI__.core.invoke`）。 */
  core?: { invoke?: TauriInvoke };
  /** Tauri 1 旧结构的兜底。 */
  invoke?: TauriInvoke;
  event?: TauriEventApi;
}

function getTauri(): TauriGlobal | null {
  const candidate = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
  return candidate ?? null;
}

export function isTauri(): boolean {
  return getTauri() !== null;
}

/**
 * 挂载托盘/热键桥接。
 *
 * 在纯浏览器环境下只注册键盘兜底（Ctrl+Alt+D 展开），保证开发时可调试。
 */
export function mountTrayBridge(bridge: TrayBridge): void {
  const tauri = getTauri();

  if (!tauri?.event) {
    window.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        bridge.onWake();
      }
    });
    return;
  }

  void tauri.event.listen("dounai://toggle-panel", () => bridge.onTogglePanel());
  void tauri.event.listen("dounai://wake", () => bridge.onWake());
  void tauri.event.listen("dounai://dnd", (event) => bridge.onDndChanged(Boolean(event.payload)));
  void tauri.event.listen("dounai://quit", () => bridge.onQuit());
}

/** 通知主进程当前面板可见性，用于主进程决定是否吸附/穿透。 */
export async function notifyPanelVisibility(visible: boolean): Promise<void> {
  const tauri = getTauri();
  const invoke = tauri?.core?.invoke ?? tauri?.invoke;
  if (!invoke) return;
  try {
    await invoke("set_panel_visible", { visible });
  } catch {
    // 主进程未实现该命令时不影响 UI
  }
}
