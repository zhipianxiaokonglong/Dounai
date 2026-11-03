/**
 * D-03 / D-05 回归测试。
 *
 * D-03：失效的 prompt_profile 不得打死整轮（宁可回落默认人格）。
 * D-05：上游错误码要映射成人话，不能一律"上游服务返回了错误"。
 */

import { describe, expect, it } from "vitest";

import { resolvePromptProfileId } from "../src/contracts/index.js";
import { userFacingError, UpstreamRejectedError } from "../src/upstream/adapters.js";

/* ------------------------------------------------------------------ */
/* D-03                                                                */
/* ------------------------------------------------------------------ */

describe("D-03 提示词配置失效保护", () => {
  const known = new Set(["builtin:default", "custom:1"]);

  it("选中的 id 存在时原样返回", () => {
    expect(resolvePromptProfileId("custom:1", known)).toEqual({ profile: "custom:1" });
  });

  it("选中的 id 已不存在时标记为 stale，不返回 profile", () => {
    const r = resolvePromptProfileId("custom:2", known);
    expect(r.stale).toBe("custom:2");
    expect(r.profile).toBeUndefined();
  });

  it("未选择（空串）时既不传也不报 stale", () => {
    expect(resolvePromptProfileId("", known)).toEqual({});
    expect(resolvePromptProfileId("   ", known)).toEqual({});
  });

  it("还没拿到已知集合时保守放行（由上游判定）", () => {
    expect(resolvePromptProfileId("custom:1", null)).toEqual({ profile: "custom:1" });
  });

  it("集合里没有该 id 但请求为空串时不误判", () => {
    expect(resolvePromptProfileId("", new Set())).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* D-05                                                                */
/* ------------------------------------------------------------------ */

/** 构造一个上游拒绝错误（供映射测试用）。 */
function rejected(code: string): UpstreamRejectedError {
  return new UpstreamRejectedError("omninexus", {
    code,
    message: "raw upstream message",
    retryable: false,
    requestId: null,
  });
}

describe("D-05 错误码映射", () => {
  const cases: Array<[string, string]> = [
    // 模型 / 厂商
    ["NO_PROVIDER_AVAILABLE", "配置一个厂商密钥"],
    ["ALL_PROVIDERS_FAILED", "配置一个厂商密钥"],
    ["PROVIDER_UNAVAILABLE", "配置一个厂商密钥"],
    ["MODEL_UNAVAILABLE", "配置一个厂商密钥"],
    ["UNKNOWN_MODEL", "配置一个厂商密钥"],
    ["PROVIDER_AUTH", "鉴权失败"],
    ["PROVIDER_TEST_AUTH_FAILED", "鉴权失败"],
    ["PROVIDER_RATE_LIMITED", "限流"],
    ["PROVIDER_TIMEOUT", "超时"],
    ["PROVIDER_TEST_UNREACHABLE", "连不上模型厂商"],
    // 会话 / 提示词
    ["SESSION_NOT_FOUND", "新对话"],
    ["PROMPT_NOT_FOUND", "提示词配置不存在"],
    ["PROMPT_INVALID", "不合规"],
    // 输入 / 容量
    ["UNSUPPORTED_MODALITY", "不接受这种输入类型"],
    ["PAYLOAD_TOO_LARGE", "太大了"],
    ["EVENT_DUPLICATE", "重复"],
    // 降级项
    ["MEMORY_UNAVAILABLE", "记忆模块"],
    ["SEARCH_NOT_CONFIGURED", "联网检索不可用"],
    // 语音层
    ["no_ready_provider", "语音厂商"],
    ["missing_credentials", "语音厂商缺少密钥"],
    ["content_too_long", "太长"],
    // 中断
    ["GENERATION_INTERRUPTED", "中断"],
  ];

  for (const [code, expectText] of cases) {
    it(`${code} 映射到可定位的提示`, () => {
      const msg = userFacingError(rejected(code));
      expect(msg).toContain(expectText);
      // 反向断言：不得落到兜底文案（那正是原缺陷）
      expect(msg).not.toBe("上游服务返回了错误，稍后重试。");
    });
  }

  it("未知错误码仍走兜底，不抛出", () => {
    expect(userFacingError(rejected("SOMETHING_NEW"))).toBe(
      "上游服务返回了错误，稍后重试。",
    );
  });

  it("不把上游原文透给用户", () => {
    const msg = userFacingError(rejected("PROVIDER_AUTH"));
    expect(msg).not.toContain("raw upstream message");
  });
});
