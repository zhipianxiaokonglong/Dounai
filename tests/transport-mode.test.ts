/**
 * Tauri 环境探测回归测试（来自 PR #1 的建议）。
 *
 * 背景：桌面端曾长期无法连上游，根因是前端探测不到 Tauri 2 的 invoke
 * （`__TAURI__.invoke` 不存在，实际位于 `__TAURI__.core.invoke`），
 * 于是退回浏览器直连、被上游 CORS 拦截。
 *
 * 这类问题**只在打包后暴露**，浏览器 dev 模式下永远正常，
 * 因此必须用「伪造全局」在单测里锁死三种形态，否则很容易复发。
 */

import { afterEach, describe, expect, it } from "vitest";

type GlobalWithTauri = { __TAURI__?: unknown };

const g = globalThis as GlobalWithTauri;

function setTauri(value: unknown): void {
  g.__TAURI__ = value;
}

afterEach(() => {
  delete g.__TAURI__;
});

/** transportMode 是纯函数式判定，直接调用即可（不涉及网络）。 */
async function transportMode(): Promise<"proxy" | "direct"> {
  const mod = await import("../src/upstream/transport.js");
  return mod.transportMode();
}

describe("transportMode：Tauri 全局结构判定", () => {
  it("__TAURI__.core.invoke 存在 → proxy（Tauri 2 正确结构）", async () => {
    setTauri({ core: { invoke: async () => undefined } });
    await expect(transportMode()).resolves.toBe("proxy");
  });

  it("只有 __TAURI__.invoke → proxy（Tauri 1 结构兼容）", async () => {
    setTauri({ invoke: async () => undefined });
    await expect(transportMode()).resolves.toBe("proxy");
  });

  it("__TAURI__ 存在但无 invoke → direct（不得误判为 proxy）", async () => {
    // 最危险的中间态：全局注入了但拿不到 invoke。
    // 若误判为 proxy，请求会走一条不存在的通道，表现为全部请求失败。
    setTauri({ event: {} });
    await expect(transportMode()).resolves.toBe("direct");
  });

  it("无 __TAURI__ → direct（浏览器 / 静态预览）", async () => {
    delete g.__TAURI__;
    await expect(transportMode()).resolves.toBe("direct");
  });

  it("__TAURI__ 为 null → direct 且不崩溃", async () => {
    setTauri(null);
    await expect(transportMode()).resolves.toBe("direct");
  });
});

describe("detectRuntime：与 transportMode 口径一致", () => {
  it("有 core.invoke 时判定为 tauri", async () => {
    setTauri({ core: { invoke: async () => undefined } });
    const { detectRuntime } = await import("../src/ui/runtime.js");
    expect(detectRuntime()).toBe("tauri");
  });

  it("__TAURI__ 存在但 invoke 不可达时，不得判成 tauri", async () => {
    // 这条是防止「两处判定打架」的护栏：
    // 若 detectRuntime 用 __TAURI__ 存在性判断，这里会得到 tauri，
    // 而 transportMode 给 direct —— 端点解析与传输层走不同路径。
    setTauri({ event: {} });
    const { detectRuntime } = await import("../src/ui/runtime.js");
    expect(detectRuntime()).not.toBe("tauri");
  });
});

describe("toBase64：二进制上传编码", () => {
  it("空数组编码为空串", async () => {
    const { toBase64 } = await import("../src/upstream/transport.js");
    expect(toBase64(new Uint8Array([]))).toBe("");
  });

  it("小数据编码正确", async () => {
    const { toBase64 } = await import("../src/upstream/transport.js");
    // "abc" 的 base64 是 "YWJj"
    expect(toBase64(new Uint8Array([97, 98, 99]))).toBe("YWJj");
  });

  it("大数组分块编码，不抛栈溢出", async () => {
    const { toBase64 } = await import("../src/upstream/transport.js");
    const big = new Uint8Array(500_000);
    big.fill(65); // 'A' = 0x41
    const encoded = toBase64(big);
    expect(encoded.length).toBeGreaterThan(600_000);
    expect(encoded.startsWith("QUFB")).toBe(true);
  });
});
