/**
 * 集成测试共用工具。
 *
 * 为什么要动态选模型：测试原先硬编码 `echo:echo`，
 * 而 echo 是否可用取决于 OmniNexus 的配置（`provider_disabled` 时不可用）。
 * 硬编码会让 `npm test` 的结果依赖于开发者本机的模型配置，
 * 且失败信息是 503，容易被误读为"链路有问题"。
 */

import type { ModelEntry } from "../../src/contracts/index.js";
import { LLMAdapter } from "../../src/upstream/adapters.js";

/** 集成测试可用模型的探测结果。 */
export interface ModelPick {
  /** 可用模型；null 表示没有 */
  model: string | null;
  /** 不可用时的原因（供跳过说明） */
  reason: string;
}

/**
 * 从模型层挑一个当前**真正可用**的模型。
 *
 * 判据是 `/v1/models` 的 `available` 字段，不是配置里写了什么——
 * 因为密钥缺失、厂商被禁用都会让它变成 false。
 */
export async function pickAvailableModel(llm: LLMAdapter): Promise<ModelPick> {
  let models: ModelEntry[];
  try {
    models = await llm.listModels();
  } catch (error) {
    return { model: null, reason: `模型清单不可读：${String(error)}` };
  }

  if (models.length === 0) {
    return { model: null, reason: "模型层没有返回任何模型" };
  }

  const usable = models.find((m) => m.available);
  if (usable) {
    return { model: usable.id, reason: "" };
  }

  // 一个都没有：把各模型的原因汇总，便于判断是"没配密钥"还是"全被禁用"
  const reasons = models
    .slice(0, 3)
    .map((m) => `${m.id}: ${m.unavailableReason ?? "unknown"}`)
    .join("; ");
  return {
    model: null,
    reason: `没有可用模型（前几个：${reasons}）`,
  };
}

/**
 * 打印跳过说明并返回 true，供测试用 `if (skip(...)) return;` 收尾。
 *
 * 为什么不用 vitest 的 `test.skip`：那些用例需要先连上游才能判断能否跑，
 * 而 `test.skip` 是静态的。运行期跳过更准确。
 */
export function skipWhenNoModel(suite: string, reason: string): boolean {
  // eslint-disable-next-line no-console
  console.warn(`[integration] ${suite} 跳过：${reason}`);
  return true;
}
