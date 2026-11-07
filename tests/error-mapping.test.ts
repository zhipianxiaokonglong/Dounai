/**
 * 错误码映射与 retryable 推断的回归测试。
 *
 * 背景（Issue #2）：输入层 10 个错误码此前全部未映射，一律落到
 * 「上游服务返回了错误，稍后重试」；且输入层/语音层错误体不带
 * `retryable`，缺省成 false，「临时故障可重试」也说错了。
 */

import { describe, expect, it } from "vitest";

import {
  normalizeContentType,
  normalizeEmotion,
  normalizeIntent,
  parseLLMEvent,
  parseUpstreamError,
} from "../src/contracts/index.js";
import { userFacingError, UpstreamRejectedError } from "../src/upstream/adapters.js";

function rejected(code: string, message = "upstream said no"): UpstreamRejectedError {
  return new UpstreamRejectedError("input", {
    code,
    message,
    retryable: false,
    requestId: null,
  });
}

describe("输入层错误码映射（此前 0 覆盖）", () => {
  it("超限给出「太大」而非泛化兜底", () => {
    const text = userFacingError(rejected("payload_too_large"));
    expect(text).toContain("太大");
    expect(text).not.toContain("稍后重试。"); // 不该是兜底文案
  });

  it("隐私拒答说明内容未上传", () => {
    expect(userFacingError(rejected("privacy_disabled"))).toContain("隐私");
  });

  it("缺授权给出授权提示", () => {
    expect(userFacingError(rejected("consent_required"))).toContain("授权");
  });

  it("鉴权失败指向令牌配置", () => {
    expect(userFacingError(rejected("unauthorized"))).toContain("令牌");
  });

  it("格式不支持给出可用的替代格式", () => {
    const text = userFacingError(rejected("unsupported_media"));
    expect(text).toContain("PNG");
    expect(text).toContain("WAV");
  });

  it("来源被拒指向白名单配置", () => {
    expect(userFacingError(rejected("forbidden_origin"))).toContain("白名单");
  });

  it("其余输入层码都有专属文案（不再落兜底）", () => {
    for (const code of ["invalid_input", "invalid_request", "provider_unavailable", "conflict", "not_found"]) {
      const text = userFacingError(rejected(code));
      expect(text, `${code} 不应落到兜底`).not.toBe("上游服务返回了错误，稍后重试。");
    }
  });
});

describe("语音层错误码映射", () => {
  it("格式不支持与厂商未知各有专属文案", () => {
    expect(userFacingError(rejected("unsupported_format"))).toContain("格式");
    expect(userFacingError(rejected("unknown_provider"))).toContain("厂商");
  });

  it("缓存失败说明不影响正文", () => {
    expect(userFacingError(rejected("cache_write_failed"))).toContain("不影响本次内容");
  });
});

describe("retryable 按码推断（上游未提供时）", () => {
  it("输入层未带 retryable 时，临时故障判为可重试", () => {
    const e = parseUpstreamError({ error: { code: "provider_unavailable", message: "x" } });
    expect(e.retryable).toBe(true);
  });

  it("输入层未带 retryable 时，参数错误判为不可重试", () => {
    for (const code of ["invalid_input", "payload_too_large", "unauthorized"]) {
      const e = parseUpstreamError({ error: { code, message: "x" } });
      expect(e.retryable, `${code} 不该被判可重试`).toBe(false);
    }
  });

  it("上游显式给了 retryable 时以其为准（不被推断覆盖）", () => {
    const e = parseUpstreamError({
      error: { code: "provider_unavailable", message: "x", retryable: false },
    });
    expect(e.retryable).toBe(false);
  });

  it("未知码缺省不可重试（保守）", () => {
    const e = parseUpstreamError({ error: { code: "some_new_code", message: "x" } });
    expect(e.retryable).toBe(false);
  });
});

describe("情绪/内容类型/意图 归一化（三个类型此前从未被使用）", () => {
  it("契约内情绪原样保留", () => {
    const r = normalizeEmotion("joy");
    expect(r.value).toBe("joy");
    expect(r.unknown).toBe(false);
  });

  it("comfort 现在属于契约内（v2 的 12 类之一）", () => {
    const r = normalizeEmotion("comfort");
    expect(r.value).toBe("comfort");
    expect(r.unknown).toBe(false);
  });

  it("旧版别名按上游同表映射，不算越界", () => {
    expect(normalizeEmotion("fear").value).toBe("sadness");
    expect(normalizeEmotion("confusion").value).toBe("frustration");
    expect(normalizeEmotion("gratitude").value).toBe("joy");
    expect(normalizeEmotion("gratitude").unknown).toBe(false);
  });

  it("真正越界的值仍收敛为 neutral 并标记 unknown", () => {
    const r = normalizeEmotion("ecstatic");
    expect(r.value).toBe("neutral");
    expect(r.unknown).toBe(true);
  });

  it("内容类型与意图同样收敛", () => {
    expect(normalizeContentType("code").value).toBe("code");
    expect(normalizeContentType("video").unknown).toBe(true);
    expect(normalizeIntent("tool").value).toBe("tool");
    expect(normalizeIntent("whatever").value).toBe("reply");
  });

  it("parseLLMEvent 走归一化：越界值不会漏进 OutputTags", () => {
    const ev = parseLLMEvent({
      event_id: "e1",
      session_id: "s1",
      content: "hi",
      stream: true,
      tags: { emotion: "ecstatic", type: "html", intent: "unknown-x" },
    }, true);
    expect(ev.tags.emotion).toBe("neutral");
    expect(ev.tags.type).toBe("text");
    expect(ev.tags.intent).toBe("reply");
  });
});
