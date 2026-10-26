/**
 * 端点解析：让同一份前端代码在三种环境下都能工作。
 *
 *  1. Tauri 生产：请求经主进程代理（`__TAURI__.core.invoke` 可调用），端点仍是 127.0.0.1 直连地址；
 *  2. Vite 开发：走 `/api/*` 前缀，由 Vite 代理转发，避开浏览器跨域；
 *  3. 纯静态预览：无代理可用，直连会失败并提示（用于验证降级 UI）。
 *
 * 注意：用户设置里的端点**只在非 dev-proxy 模式**生效。
 * 在 dev-proxy 模式下必须强制使用 `/api/*`，否则会绕过代理直连上游，
 * 被 output 的 Origin 白名单拒绝（这正是最初误判为「服务未连接」的原因）。
 */

import type { Endpoints } from "../upstream/adapters.js";
import { transportMode } from "../upstream/transport.js";

export type Runtime = "tauri" | "dev-proxy" | "static";

const LOOPBACK: Endpoints = {
  input: "http://127.0.0.1:8101",
  llm: "http://127.0.0.1:8102",
  output: "http://127.0.0.1:8103",
};

const PROXIED: Endpoints = {
  input: "/api/input",
  llm: "/api/llm",
  output: "/api/output",
};

/**
 * 是否运行在 Tauri 桌面端。
 *
 * 判定口径必须与 `transport.transportMode()` **完全一致**，都基于
 * 「invoke 是否真的可调用」，而不是「__TAURI__ 是否存在」。
 *
 * 原因：Tauri 2 把 invoke 放在 `__TAURI__.core.invoke`，只检查 `__TAURI__`
 * 会漏判（历史上正是这个差异导致桌面端误判为浏览器直连，被上游 CORS 拦截）。
 * 反过来，若 `__TAURI__` 存在却取不到 invoke，判成 tauri 会让端点解析走直连地址，
 * 而传输层又走 direct —— 两处结论打架。所以统一以 invoke 可达性为唯一真相来源。
 */
export function detectRuntime(): Runtime {
  if (transportMode() === "proxy") return "tauri";
  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  return isDev ? "dev-proxy" : "static";
}

export function resolveEndpoints(overrides?: Partial<Endpoints>): Endpoints {
  const runtime = detectRuntime();

  if (runtime === "dev-proxy") {
    // 开发模式强制走代理前缀；用户覆盖项被忽略是有意为之。
    return { ...PROXIED };
  }

  // Tauri 与静态预览：用用户配置的地址，缺省回环。
  const merged = { ...LOOPBACK };
  for (const key of ["input", "llm", "output"] as const) {
    const value = overrides?.[key];
    if (typeof value === "string" && value.trim().length > 0) merged[key] = value.trim();
  }
  return merged;
}

/**
 * 音频地址的基址。
 *
 * dev-proxy 下 audio_ref 也必须走代理前缀，否则 <audio> 直连 8103
 * 会被 output 的 Origin 校验拒绝（表现为「有 URL 但播放失败」）。
 */
export function resolveAudioBase(endpoints: Endpoints, runtime: Runtime): string {
  if (runtime === "dev-proxy") return endpoints.output;
  return endpoints.output;
}
