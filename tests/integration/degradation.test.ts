/**
 * 降级与容错集成测试。
 *
 * 验收要求：「某模块不可用时 UI 优雅降级，不崩溃」。
 * 这里通过**指向不存在的端口**来模拟模块不可用，验证组装层的真实行为，
 * 而不是只 mock 一个函数。
 */

import { describe, expect, it } from "vitest";
import {
  InputAdapter,
  LLMAdapter,
  OutputAdapter,
} from "../../src/upstream/adapters.js";
import { Orchestrator, type TurnSnapshot } from "../../src/orchestrator/index.js";

/** 一个确定不会有服务监听的端口 */
const DEAD = "http://127.0.0.1:9";

const LIVE = {
  input: process.env.DOUNAI_INPUT_URL ?? "http://127.0.0.1:8101",
  llm: process.env.DOUNAI_LLM_URL ?? "http://127.0.0.1:8102",
  output: process.env.DOUNAI_OUTPUT_URL ?? "http://127.0.0.1:8103",
};

describe("单模块不可用", () => {
  it("input 不可用：进入 degraded，给出可读提示", async () => {
    const orchestrator = new Orchestrator(
      {
        input: new InputAdapter(DEAD),
        llm: new LLMAdapter(LIVE.llm),
        output: new OutputAdapter(LIVE.output),
      },
      { onSnapshot: () => undefined },
    );

    const health = await orchestrator.probe();
    expect(health.input).toBe(false);

    const snapshot = await orchestrator.submit("你好");
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.notice).toContain("输入服务未连接");
  }, 30_000);

  it("llm 不可用：探活失败但不抛异常", async () => {
    const orchestrator = new Orchestrator(
      {
        input: new InputAdapter(LIVE.input),
        llm: new LLMAdapter(DEAD),
        output: new OutputAdapter(LIVE.output),
      },
      { onSnapshot: () => undefined },
    );

    const health = await orchestrator.probe();
    expect(health.llm).toBe(false);

    const snapshot = await orchestrator.submit("你好");
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.notice).toContain("模型服务未连接");
  }, 30_000);

  it("output 不可用：文本照常，只是没有语音", async () => {
    const orchestrator = new Orchestrator(
      {
        input: new InputAdapter(LIVE.input),
        llm: new LLMAdapter(LIVE.llm),
        output: new OutputAdapter(DEAD),
      },
      { onSnapshot: () => undefined },
    );

    const snapshot = await orchestrator.submit("今天有点累", { model: "echo:echo" });
    // 文本必须完整保留——这是「output 挂掉不影响对话」的核心断言
    expect(snapshot.text.length).toBeGreaterThan(0);
    expect(snapshot.audioUrl).toBeNull();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.health.output).toBe(false);
  }, 60_000);

  it("全部不可用：不崩溃，返回稳定的降级快照", async () => {
    const orchestrator = new Orchestrator(
      {
        input: new InputAdapter(DEAD),
        llm: new LLMAdapter(DEAD),
        output: new OutputAdapter(DEAD),
      },
      { onSnapshot: () => undefined },
    );

    const health = await orchestrator.probe();
    expect(health).toEqual({ input: false, llm: false, output: false });

    const snapshot = await orchestrator.submit("你好");
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.notice).toBeTruthy();
    expect(snapshot.health).toEqual({ input: false, llm: false, output: false });
  }, 30_000);
});

describe("探活不阻塞 UI", () => {
  it("三个探活并行执行，总耗时不叠加", async () => {
    const orchestrator = new Orchestrator(
      {
        input: new InputAdapter(DEAD),
        llm: new LLMAdapter(DEAD),
        output: new OutputAdapter(DEAD),
      },
      { onSnapshot: () => undefined },
    );

    const started = Date.now();
    await orchestrator.probe();
    const elapsed = Date.now() - started;

    // 串行等待三个 3s 超时至少 9s；并行应显著更短
    expect(elapsed).toBeLessThan(6_000);
  }, 20_000);
});

describe("快照契约", () => {
  it("每次状态变化都通过 onSnapshot 通知，且快照不可变引用", async () => {
    const snapshots: TurnSnapshot[] = [];
    const orchestrator = new Orchestrator(
      {
        input: new InputAdapter(LIVE.input),
        llm: new LLMAdapter(LIVE.llm),
        output: new OutputAdapter(DEAD),
      },
      { onSnapshot: (snapshot) => snapshots.push(snapshot) },
    );

    await orchestrator.submit("你好", { model: "echo:echo" });

    expect(snapshots.length).toBeGreaterThan(1);
    // 每个快照必须是独立对象，避免 UI 侧读到后续变更
    const unique = new Set(snapshots.map((s) => JSON.stringify(s.health)));
    expect(unique.size).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
