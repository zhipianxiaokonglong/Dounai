/**
 * 传输层：屏蔽「浏览器直连」与「主进程代理」的差异。
 *
 * 背景（见 docs/cors-and-proxy.md）：三个上游都不允许浏览器跨域直连，
 * 因此生产环境（Tauri）必须经主进程转发；开发环境用 Vite 代理等价实现。
 *
 * 适配器只依赖本模块的 `request` / `requestStream`，不关心底层走哪条路。
 */

export interface HttpRequest {
  url: string;
  method: string;
  body?: string;
  /**
   * 二进制请求体（图像/语音上传用）。
   *
   * 为什么单独一个字段而不是复用 `body`：主进程代理通过 JSON IPC 通信，
   * 无法直接传字节数组。这里统一转成 base64 交给 Rust 侧解码还原，
   * 而直连模式直接交给 fetch —— 两条路径的语义由本层吸收，适配器无感知。
   */
  bodyBytes?: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  elapsedMs: number;
}

export type TransportMode = "proxy" | "direct";

interface TauriInvoke {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface TauriGlobal {
  /** Tauri 2：invoke 位于 `core` 命名空间（`window.__TAURI__.core.invoke`）。 */
  core?: { invoke?: TauriInvoke };
  /** Tauri 1 旧结构的兜底。 */
  invoke?: TauriInvoke;
}

function tauriInvoke(): TauriInvoke | null {
  const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
  return tauri?.core?.invoke ?? tauri?.invoke ?? null;
}

export function transportMode(): TransportMode {
  return tauriInvoke() ? "proxy" : "direct";
}

/** 统一请求入口。失败时抛 TransportError，由适配器转成上游错误。 */
export async function request(req: HttpRequest): Promise<HttpResponse> {
  const invoke = tauriInvoke();
  if (invoke) return viaProxy(invoke, req);
  return viaFetch(req);
}

async function viaProxy(invoke: TauriInvoke, req: HttpRequest): Promise<HttpResponse> {
  const payload = {
    request: {
      url: req.url,
      method: req.method,
      body: req.bodyBytes ? null : (req.body ?? null),
      body_base64: req.bodyBytes ? toBase64(req.bodyBytes) : null,
      headers: Object.entries(req.headers ?? {}),
      timeout_ms: req.timeoutMs ?? 30_000,
    },
  };

  try {
    const raw = (await invoke("upstream_request", payload)) as {
      status: number;
      body: string;
      headers: Array<[string, string]>;
      elapsed_ms: number;
    };
    return {
      status: raw.status,
      body: raw.body,
      headers: Object.fromEntries(raw.headers ?? []),
      elapsedMs: raw.elapsed_ms ?? 0,
    };
  } catch (error) {
    // 主进程返回的是 { kind, message } 结构
    const detail = error as { kind?: string; message?: string };
    const kind = detail?.kind ?? "request";
    throw new TransportError(kind, detail?.message ?? String(error));
  }
}

/**
 * 主进程流式代理：逐块接收 SSE。
 *
 * 与 `viaProxy` 的区别：那个等全部收完再返回，本函数每收到一行就回调，
 * 因此首字延迟从"整轮耗时"降到"首包耗时"。
 *
 * 错误处理约定：
 * - 建连失败 / 流中途出错 → 主进程通过 channel 发 `error` 块，这里抛 TransportError
 * - HTTP >= 400 → 主进程发 `head` 时带 status，这里据此抛错
 */
async function viaProxyStream(
  invoke: TauriInvoke,
  req: HttpRequest,
  onChunk: (chunk: string) => boolean | void,
): Promise<void> {
  // Tauri 2 的 Channel 构造函数挂在 __TAURI__.core 上
  const tauri = (globalThis as {
    __TAURI__?: { core?: { Channel?: new () => TauriChannel } };
  }).__TAURI__;
  const ChannelCtor = tauri?.core?.Channel;
  if (!ChannelCtor) {
    // 极端情况：运行时没有 Channel（旧版 Tauri）。
    // 退回整包代理，保证功能不中断，但会失去流式体验。
    const response = await viaProxy(invoke, { ...req, timeoutMs: req.timeoutMs ?? 120_000 });
    if (response.status >= 400) {
      throw new TransportError("http", `上游返回 ${response.status}`);
    }
    onChunk(response.body);
    return;
  }

  const channel = new ChannelCtor();
  let settled = false;
  let failure: TransportError | null = null;
  let httpStatus = 0;

  // 用一个 promise 等流结束，避免 invoke 返回后立即 resolve
  let resolveDone!: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  channel.onmessage = (message: unknown) => {
    const chunk = message as StreamChunkMessage;
    switch (chunk?.type) {
      case "head":
        httpStatus = chunk.status ?? 0;
        break;
      case "data":
        if (httpStatus >= 400) {
          // 错误体的正文也照常交给上层解析（便于提取 error.code）
          onChunk(chunk.text ?? "");
          break;
        }
        if (onChunk(chunk.text ?? "") === true) {
          // 上层已收到终止帧：不再等待服务端关闭
          if (!settled) {
            settled = true;
            resolveDone();
          }
        }
        break;
      case "done":
        if (!settled) {
          settled = true;
          resolveDone();
        }
        break;
      case "error":
        failure = new TransportError(
          chunk.kind === "timeout" ? "timeout" : chunk.kind === "unavailable" ? "unavailable" : "request",
          chunk.message ?? "流式请求失败",
        );
        if (!settled) {
          settled = true;
          resolveDone();
        }
        break;
      default:
        break;
    }
  };

  try {
    await invoke("upstream_request_stream", {
      request: {
        url: req.url,
        method: req.method,
        body: req.body ?? null,
        body_base64: null,
        headers: Object.entries(req.headers ?? {}),
        timeout_ms: req.timeoutMs ?? 120_000,
      },
      onEvent: channel,
    });
  } catch (error) {
    const detail = error as { kind?: string; message?: string };
    throw new TransportError(detail?.kind ?? "request", detail?.message ?? String(error));
  }

  await donePromise;

  if (failure) throw failure;
  if (httpStatus >= 400) {
    throw new TransportError("http", `上游返回 ${httpStatus}`);
  }
}

/** 主进程推来的流式块（与 Rust 侧 StreamChunk 对应）。 */
interface StreamChunkMessage {
  type: "head" | "data" | "done" | "error";
  status?: number;
  headers?: Array<[string, string]>;
  text?: string;
  elapsed_ms?: number;
  kind?: string;
  message?: string;
}

/** 前端 Channel 的最小形态（只用到 onmessage）。 */
interface TauriChannel {
  onmessage: (message: unknown) => void;
}

async function viaFetch(req: HttpRequest): Promise<HttpResponse> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 30_000);

  if (req.signal) {
    req.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      // 复制成独立 ArrayBuffer，避免 SharedArrayBuffer 与视图偏移带来的类型/行为歧义
      body: req.bodyBytes ? new Blob([Uint8Array.from(req.bodyBytes).buffer]) : req.body,
      signal: controller.signal,
    });
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, body, headers, elapsedMs: Date.now() - started };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TransportError("timeout", `请求超时：${req.url}`);
    }
    throw new TransportError("unavailable", describeFetchFailure(error, req.url));
  } finally {
    clearTimeout(timeout);
  }
}

/** Uint8Array → base64；分块处理，避免大图（15MB）导致调用栈溢出。 */
export function toBase64(bytes: Uint8Array): string {
  const hasBtoa = typeof (globalThis as { btoa?: unknown }).btoa === "function";
  if (hasBtoa) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return (globalThis as { btoa: (s: string) => string }).btoa(binary);
  }
  // Node 测试环境兜底
  const bufferCtor = (globalThis as { Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } } })
    .Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString("base64");
  throw new TransportError("encode", "当前环境不支持 base64 编码");
}

/**
 * fetch 失败的原因在浏览器里被刻意模糊化（CORS 与网络错误都报 "Failed to fetch"）。
 * 这里给出可操作的诊断提示，避免用户误以为上游挂了。
 */
function describeFetchFailure(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return (
      `${url} 无法访问。若服务确实在运行，通常是浏览器跨域拦截：` +
      `请通过桌面应用（主进程代理）或 Vite 代理访问，详见 docs/cors-and-proxy.md`
    );
  }
  return message;
}

export class TransportError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
  }
}

/**
 * 读 SSE。
 *
 * **关键时序约定**：上游在发出 `final` / `error` 后并不保证立即关闭连接
 * （OmniNexus 会保持连接以便后续轮次复用，浏览器侧尤其明显）。
 * 若把「读到 EOF」当作回合结束条件，UI 会永远停在等待态——这正是
 * 实测中「对话卡住」的根因。
 *
 * 因此 `onChunk` 返回 `true` 表示「已收到终止帧，可以停止读取」，
 * 这里会主动 `cancel()` 掉 reader，不等 socket 关闭。
 */
export async function requestStream(
  req: HttpRequest,
  onChunk: (chunk: string) => boolean | void,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    // 桌面端：走主进程的真流式代理。
    //
    // 历史做法是 viaProxy 一次性取回完整 SSE 再整体派发——那意味着
    // 从发请求到首字上屏之间界面完全静止（实测 ~2.5s，推理模型可达数十秒），
    // 用户会以为程序卡死。
    //
    // 现在用 Tauri Channel 逐块接收，主进程每读到一行 SSE 就推一次。
    await viaProxyStream(invoke, req, onChunk);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 120_000);
  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new TransportError("http", `上游返回 ${response.status}`);
    }
    if (!response.body) throw new TransportError("unavailable", "响应没有流式正文");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const stop = onChunk(decoder.decode(value, { stream: true }));
        if (stop === true) {
          // 已收到终止帧：主动释放连接，不等服务端关闭
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TransportError("timeout", `请求超时：${req.url}`);
    }
    if (error instanceof TransportError) throw error;
    throw new TransportError("unavailable", describeFetchFailure(error, req.url));
  } finally {
    clearTimeout(timeout);
  }
}
