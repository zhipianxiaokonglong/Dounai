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

function tauriInvoke(): TauriInvoke | null {
  const tauri = (globalThis as { __TAURI__?: { invoke?: TauriInvoke } }).__TAURI__;
  return tauri?.invoke ?? null;
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
      body: req.body ?? null,
      headers: Object.entries(req.headers ?? {}),
      timeout_ms: req.timeoutMs ?? 30_000,
      stream: false,
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
      body: req.body,
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
    // 主进程一次性返回完整 SSE 文本：契约里帧很小，且回合结束才需要 final，
    // 因此这里按整包接收再逐帧派发，UI 的流式体验由帧回调保证。
    const response = await viaProxy(invoke, { ...req, timeoutMs: req.timeoutMs ?? 120_000 });
    if (response.status >= 400) {
      throw new TransportError("http", `上游返回 ${response.status}`);
    }
    onChunk(response.body);
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
