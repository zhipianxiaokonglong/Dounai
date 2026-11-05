/**
 * 模型下拉逻辑测试（补 UI 层空白）。
 *
 * 背景：`loadModels()` 曾经只定义、从未被调用，导致模型下拉永远只有
 * 「自动选择模型」一项。tsc 和既有单测都发现不了——因为这是个
 * **调用缺失**，不是类型错误，也没有测试覆盖到这条路径。
 *
 * 这里补上：
 * 1. 模型清单如何映射成下拉选项（含能力标注）
 * 2. 能力检查与下拉选项的一致性
 */

import { describe, expect, it } from "vitest";

import { parseModels } from "../src/contracts/index.js";

/** 构造一个 /v1/models 响应。 */
function makeModelsResponse() {
  return {
    models: [
      {
        id: "openai:gpt-4o",
        label: "GPT-4o",
        providerKind: "builtin",
        providerName: "OpenAI",
        model: "gpt-4o",
        capabilities: { inputModalities: ["text", "image"], contextWindow: 128000 },
        available: true,
        verification: "ok",
      },
      {
        id: "ollama:llama3",
        label: "Llama 3",
        providerKind: "custom",
        providerName: "Ollama",
        model: "llama3",
        capabilities: { inputModalities: ["text"], contextWindow: 8192 },
        available: true,
        verification: "unverified",
      },
      {
        id: "openai:gpt-4o-mini",
        label: "GPT-4o mini",
        providerKind: "builtin",
        providerName: "OpenAI",
        model: "gpt-4o-mini",
        capabilities: { inputModalities: ["text"] },
        available: false,
        unavailableReason: "missing_api_key",
        verification: "unverified",
      },
    ],
  };
}

/**
 * 复刻 main.ts 里 `loadModels` 的选项文案生成规则。
 *
 * 为什么不直接 import：那个函数依赖 DOM 与模块级状态。
 * 这里只验证**规则本身**，能够捕获"标注逻辑写错"这类问题；
 * "是否被调用"由端到端实测守着。
 */
function describeOption(m: {
  label: string;
  available: boolean;
  inputModalities: string[];
  providerKind: string;
}): string {
  const marks: string[] = [];
  if (!m.available) marks.push("不可用");
  if (m.inputModalities.includes("image")) marks.push("可看图");
  if (m.providerKind === "custom") marks.push("自定义");
  return `${m.label}${marks.length ? "（" + marks.join("、") + "）" : ""}`;
}

describe("模型下拉选项", () => {
  it("可用 + 视觉模型标注「可看图」", () => {
    const models = parseModels(makeModelsResponse());
    expect(describeOption(models[0]!)).toBe("GPT-4o（可看图）");
  });

  it("纯文本自定义模型标注「自定义」", () => {
    const models = parseModels(makeModelsResponse());
    expect(describeOption(models[1]!)).toBe("Llama 3（自定义）");
  });

  it("不可用模型标注「不可用」", () => {
    const models = parseModels(makeModelsResponse());
    expect(describeOption(models[2]!)).toBe("GPT-4o mini（不可用）");
  });

  it("解析出的模型数量与源数据一致（防止静默丢项）", () => {
    const models = parseModels(makeModelsResponse());
    expect(models).toHaveLength(3);
    // 关键：不能因为某个字段缺失就整条丢弃
    expect(models.map((m) => m.id)).toEqual([
      "openai:gpt-4o",
      "ollama:llama3",
      "openai:gpt-4o-mini",
    ]);
  });

  it("视觉能力判定与实际能力一致", () => {
    const models = parseModels(makeModelsResponse());
    const vision = models.filter((m) => m.inputModalities.includes("image"));
    expect(vision).toHaveLength(1);
    expect(vision[0]!.id).toBe("openai:gpt-4o");
  });
});

describe("模型清解析健壮性", () => {
  it("缺 capabilities 时不崩，按纯文本处理", () => {
    const models = parseModels({
      models: [{ id: "x:y", providerKind: "builtin", available: true }],
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.inputModalities).toEqual([]);
  });

  it("跳过无 id 的坏条目，但保留其余", () => {
    const models = parseModels({
      models: [{ id: "ok:1", available: true }, { label: "无 id" }, { id: "ok:2", available: true }],
    });
    expect(models).toHaveLength(2);
  });

  it("空清单返回空数组而不是抛错", () => {
    expect(parseModels({ models: [] })).toEqual([]);
  });
});
