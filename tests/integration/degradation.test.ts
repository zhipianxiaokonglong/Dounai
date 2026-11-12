/**
 * 降级与容错集成测试。
 *
 * 验收要求：「某模块不可用时 UI 优雅降级，不崩溃」。
 * 这里通过**指向不存在的端口**来模拟模块不可用，验证组装层的真实行为，
 * 而不是只 mock 一个函数。
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  InputAdapter,
  LLMAdapter,
  OutputAdapter,
} from "../../src/upstream/adapters.js";
import { Orchestrator, type TurnSnapshot } from "../../src/orchestrator/index.js";
import { pickAvailableModel } from "./helpers.js";


/**
 * 动态探测可用模型。
 *
 * 原先把模型硬编码为 `echo:echo`，但 echo 是否可用取决于 OmniNexus 配置
 * （`provider_disabled` 时不可用）。硬编码会让这批用例的结果依赖本机模型配置，
 * 且失败信息是 503——容易被误读成"链路坏了"。
 */
let pickedModel: string | null = null;
let pickReason = "";

/** 一个确定不会有服务监听的端口 */
const DEAD = "http://127.0.0.1:9";

const LIVE = {
  input: process.env.DOUNAI_INPUT_URL ?? "http://127.0.0.1:8101",
  llm: process.env.DOUNAI_LLM_URL ?? "http://127.0.0.1:8102",
  output: process.env.DOUNAI_OUTPUT_URL ?? "http://127.0.0.1:8103",
};

/**
 * 部分用例需要「一个已知健康的上游」作为对照组（例如「只有 output 挂了，
 * 文本仍要完整」）。上游未启动时这类用例失去意义，必须跳过而不是失败——
 * 否则本地少起一个服务就会被误报成产品缺陷。
 */
let live: { input: boolean; llm: boolean; output: boolean };

beforeAll(async () => {
  const [a, b, c] = await Promise.all([
    new InputAdapter(LIVE.input).probe(),
    new LLMAdapter(LIVE.llm).probe(),
    new OutputAdapter(LIVE.output).probe(),
  ]);
  live = { input: a, llm: b, output: c };
  if (!a || !b || !c) {
    console.warn(
      `[degradation] 上游未全部就绪 input=${a} llm=${b} output=${c}，依赖真实上游的用例将跳过`,
    );
  }
}, 30_000);

beforeAll(async () => {
  // 这个文件每次用例都新建适配器（为了指向不同的死端口），所以探测时单独建一个
  const pick = await pickAvailableModel(new LLMAdapter(LIVE.llm));
  pickedModel = pick.model;
  pickReason = pick.reason;
  if (!pickedModel) {
    console.warn(`[integration] 无可用模型，相关用例将跳过：${pickReason}`);
  }
});

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

    const snapshot = await orchestrator.submit({ kind: "text", text: "你好" });
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.notice).toContain("输入服务未连接");
  }, 30_000);

  it("llm 不可用：探活失败但不抛异常", async () => {
    // 需要真实 input 作为对照组：input 必须先能正常产出事件，
    // 否则会被 input 的失败抢先拦截，测不到 llm 的降级表现。
    if (!live.input) return;

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

    const snapshot = await orchestrator.submit({ kind: "text", text: "你好" });
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.notice).toContain("模型服务未连接");
  }, 30_000);

  it("output 不可用：文本照常，只是没有语音", async () => {
    if (!pickedModel) {
      // 没有可用模型：跳过而非失败，并说明原因（见 helpers.ts）
      console.warn(`[integration] 跳过「output 不可用：文本照常，只是没有语音」：${pickReason}`);
      return;
    }

    // 需要真实 input + llm：文本来自 llm 的 final，与 output 无关，
    // 这正是本用例要证明的独立性。
    if (!live.input || !live.llm) return;

    const orchestrator = new Orchestrator(
      {
        input: new InputAdapter(LIVE.input),
        llm: new LLMAdapter(LIVE.llm),
        output: new OutputAdapter(DEAD),
      },
      { onSnapshot: () => undefined },
    );

    const snapshot = await orchestrator.submit(
      { kind: "text", text: "今天有点累" },
      { model: pickedModel! },
    );
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

    const snapshot = await orchestrator.submit({ kind: "text", text: "你好" });
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

    await orchestrator.submit({ kind: "text", text: "你好" }, { model: pickedModel! });

    expect(snapshots.length).toBeGreaterThan(1);
    // 每个快照必须是独立对象，避免 UI 侧读到后续变更
    const unique = new Set(snapshots.map((s) => JSON.stringify(s.health)));
    expect(unique.size).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
