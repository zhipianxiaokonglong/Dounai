/**
 * 端点解析：让同一份前端代码在三种环境下都能工作。
 *
 *  1. Tauri 生产：请求经主进程代理（`__TAURI__` 存在），端点仍是 127.0.0.1 直连地址；
 *  2. Vite 开发：走 `/api/*` 前缀，由 Vite 代理转发，避开浏览器跨域；
 *  3. 纯静态预览：无代理可用，直连会失败并提示（用于验证降级 UI）。
 *
 * 注意：用户设置里的端点**只在非 dev-proxy 模式**生效。
 * 在 dev-proxy 模式下必须强制使用 `/api/*`，否则会绕过代理直连上游，
 * 被 output 的 Origin 白名单拒绝（这正是最初误判为「服务未连接」的原因）。
 */

import type { Endpoints } from "../upstream/adapters.js";

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

export function detectRuntime(): Runtime {
  const hasTauri = typeof (globalThis as { __TAURI__?: unknown }).__TAURI__ !== "undefined";
  if (hasTauri) return "tauri";
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
