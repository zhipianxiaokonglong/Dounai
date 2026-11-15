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
  emit(event: string, payload?: unknown): Promise<unknown>;
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

/** 统一的自定义命令调用；浏览器预览下抛错，由调用方决定是否降级。 */
export async function invokeApp<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const tauri = getTauri();
  const invoke = tauri?.core?.invoke ?? tauri?.invoke;
  if (!invoke) throw new Error("当前环境没有 Tauri 桥接");
  return (await invoke(command, args)) as T;
}

/** 向其他窗口广播应用事件（例如设置窗口 → 悬浮窗）。 */
export async function emitAppEvent(event: string, payload?: unknown): Promise<void> {
  const tauri = getTauri();
  if (!tauri?.event?.emit) return;
  try {
    await tauri.event.emit(event, payload);
  } catch {
    // 事件是增强能力，失败不应影响设置保存
  }
}

/** 监听应用事件；返回取消函数（无 Tauri 时为空操作）。 */
export function listenAppEvent(
  event: string,
  handler: (payload: unknown) => void,
): () => void {
  const tauri = getTauri();
  if (!tauri?.event?.listen) return () => undefined;
  let unlisten: (() => void) | undefined;
  void tauri.event
    .listen(event, (message) => handler(message.payload))
    .then((fn) => {
      unlisten = fn;
    })
    .catch(() => undefined);
  return () => unlisten?.();
}

/**
 * 用系统浏览器打开某层模块的管理界面。
 *
 * 地址由 Rust 侧按固定表拼装，前端只传模块 id。
 * 管理界面由各模块自带，密钥归各模块保管——本窗口不涉及。
 */
export async function openModuleAdmin(moduleId: string): Promise<string> {
  const tauri = getTauri();
  const invoke = tauri?.core?.invoke ?? tauri?.invoke;
  if (!invoke) {
    throw new Error("当前环境没有 Tauri 桥接，无法打开管理界面");
  }
  const result = await invoke("open_module_admin", { moduleId });
  return String(result);
}
