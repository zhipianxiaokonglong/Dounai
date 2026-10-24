# Dounai 组装层 · 架构设计

> 本文档定义 Dounai 桌面悬浮窗（组装层 + UI）的职责边界、事件编排模型与可替换形象渲染层的接口。

## 1. 职责边界

组装层是产品唯一面向用户的出口。它**不**做：

- 不做语音识别、声纹唤醒（`input` 的职责）；
- 不做模型路由、提示词、上下文、情感分类（`OmniNexus` 的职责）；
- 不做 TTS 合成、情感风格映射、文本渲染切块（`output` 的职责）。

它**只**做四件事：

1. **接入**：把用户输入交给 `input`，把 `input` 事件交给 `OmniNexus`，把 LLM 输出交给 `output`；
2. **编排**：把三条上游的异步事件按 `session_id` / `event_id` 归并成一次「回合」；
3. **呈现**：按状态机驱动悬浮窗外观、文本流式显示与语音播放；
4. **兜底**：任一上游不可用时优雅降级，绝不让 UI 崩溃或卡死。

## 2. 分层

```text
┌──────────────────────────────────────────────────────────┐
│  Renderer (WebView)                                      │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ AvatarLayer    │  │ ChatStream   │  │ StatusBadge  │  │
│  │ (可替换形象)    │  │ (流式文本)    │  │ (降级/勿扰)   │  │
│  └────────────────┘  └──────────────┘  └──────────────┘  │
│           ▲ IPC (typed, versioned)          ▲             │
├───────────┼─────────────────────────────────┼─────────────┤
│  Main (Rust)                                │             │
│  ┌──────────────────────────────────────────┴───────────┐ │
│  │  Orchestrator（回合状态机 + 事件归并 + 背压）          │ │
│  └───┬──────────────┬──────────────┬────────────────────┘ │
│      │              │              │                      │
│  ┌───▼────┐   ┌─────▼─────┐  ┌─────▼─────┐                │
│  │ input  │   │ OmniNexus │  │  output   │  上游适配器      │
│  │ :8101  │   │  :8102    │  │  :8103    │  (可独立降级)    │
│  └────────┘   └───────────┘  └───────────┘                │
└──────────────────────────────────────────────────────────┘
```

**为什么状态机在主进程而不是渲染层**：窗口可能被隐藏、渲染层可能被节流（`backgroundThrottling`），
而回合的生命周期必须与窗口可见性解耦，否则「切走再切回」会丢事件或重复播放语音。

## 3. 回合状态机

```text
        wakeup 事件
Idle ──────────────► Waking ──(300ms 动效)──► Listening
  ▲                                            │
  │                                   用户提交  │
  │                                            ▼
  │                                        Thinking ──(首 token)──► Streaming
  │                                            │                       │
  │                                    上游不可用│                  final │
  │                                            ▼                       ▼
  └────────────(超时/取消/静默)──────────── Degraded ◄────── Speaking ──┘
                                                                 │
                                                            播放结束
                                                                 ▼
                                                               Idle
```

四个**对外可见**状态（与需求一致）：

| 状态 | 触发 | 表现 |
|---|---|---|
| `default` | 启动、回合结束、超时 | logo 静默悬浮，无动画或极低幅度呼吸 |
| `wakeup` | `metadata.voiceprint_event == "wakeup"` | logo 放大/高亮，短暂动效 |
| `talking` | 收到 `delta` 或音频开始播放 | 流式文本 + 语音，口型/波纹动效 |
| `emotion` | 收到 `final` 的 `tags.emotion` | **预留状态位**，默认不启用表情资源 |

`emotion` 是**预留**状态：本期只记录并透传标签，形象层提供 `setEmotion(label)` 空实现，
后续接入正式形象时无需改动编排逻辑。这是需求中「情感表现层后续启用，请预留状态位」的落地方式。

### 3.1 状态迁移的守护条件

- 任一状态都可被 `Degraded` 覆盖：上游错误优先于表现；
- `Speaking` 结束必须以**音频实际播放完毕**为准，不以 `final` 到达为准（否则音画不同步）；
- 新一轮输入到达时，若上一轮仍在 `Speaking`，先淡出旧音频再进入 `Thinking`，不硬切。

## 4. 事件归并

三条上游的事件通过以下键归并：

| 来源 | 键 | 用途 |
|---|---|---|
| `input` | `event_id` | 输入事件 ID，作为本轮幂等键传给 OmniNexus |
| `OmniNexus` | `session_id` + `event_id` | SSE 的 `delta`/`final` 共享同一 `event_id` |
| `output` | 请求体里的 `event_id` | 由组装层生成，与 OmniNexus 的输出事件一一对应 |

**关键设计**：`output` 的输入契约要求 `event_id`/`session_id`/`content`/`tags`，
而 OmniNexus 的 `final` 恰好提供 `content` + `tags`，因此组装层在收到 `final` 后
**用 final 的完整文本**调用 `output`（而非流式 delta），理由：

1. `output` 明确要求「聚合后的完整文本」，其文档写明「如果未来上游改成 token 流，
   应在接入层先聚合」——组装层就是那个接入层；
2. 用 `delta` 逐段合成会产生多次 TTS 调用与拼接断点，音色不连续，是音画不同步的根因之一。

## 5. 可替换形象渲染层

需求明确：logo 是默认形象，后续会替换为正式助手形象。因此形象层必须与交互框架解耦。

### 5.1 接口

```ts
export interface AvatarRenderer {
  /** 挂载到宿主元素；宿主尺寸由布局决定，渲染器自适应。 */
  mount(host: HTMLElement, ctx: AvatarContext): Promise<void>;
  /** 状态切换：default / wakeup / talking / emotion / degraded */
  setState(state: AvatarState): void;
  /** 情感标签（预留；默认实现为空） */
  setEmotion(emotion: string | null): void;
  /** 说话强度 0..1，用于口型/波纹；由音频分析或文本节流驱动 */
  setSpeakingLevel(level: number): void;
  /** 主题色等外观参数 */
  setTheme(theme: AvatarTheme): void;
  unmount(): void;
}

export interface AvatarContext {
  /** 只读：给渲染器读取当前状态，避免重复驱动 */
  getState(): AvatarState;
  /** 渲染器可请求一次「脉冲」动效 */
  pulse(kind: "wakeup" | "ack"): void;
  /** 尊重系统减弱动效偏好 */
  reducedMotion: boolean;
}
```

### 5.2 本期实现

`LogoAvatarRenderer`：纯 SVG + CSS，零依赖，渲染产品 logo 作为默认形象。
它的存在证明接口可用，但不绑定任何具体形象资源。

### 5.3 替换方式

新增 `Live2DAvatarRenderer` / `SpriteAvatarRenderer` 时，只需实现同一接口并在
`avatar/registry.ts` 注册，其余代码零改动。这条约定写进用户文档与开发文档。

## 6. 降级矩阵

| 不可用模块 | 检测方式 | UI 表现 | 用户可做的 |
|---|---|---|---|
| `input` | 启动探活 `/healthz` 失败 | 输入框禁用，状态徽标「输入服务未连接」 | 重试、查看排障 |
| `OmniNexus` | `/v1/healthz` 失败 | 可输入但不发送，提示「模型服务未连接」 | 同上 |
| `output` | `/api/health` 失败 | **文本正常显示**，静音图标标记，不播放 | 同上 |
| `output` 合成失败 | `status=text_fallback` / `degraded=true` | 文本照常，标注「语音不可用」 | 无感继续 |
| TTS 播放失败 | `audio` 元素 error | 跳过语音，继续下一轮 | 无感继续 |

降级必须是**逐模块独立**的：`output` 挂掉不影响对话文本，`input` 挂掉不影响已有会话回看。

## 7. 性能预算

| 指标 | 目标 | 依据 |
|---|---|---|
| 冷启动到可交互 | < 800ms | 悬浮窗常驻，用户对启动无感要求高 |
| 常驻内存（空闲） | < 120MB | 桌面宠物需长期驻留 |
| 首字上屏 | < 200ms（收到首个 delta 后） | 流式渲染必须逐帧合并，不能每 token 重排 |
| 音频起播 | < 250ms（收到音频后） | 避免「文字已读完声音才响」 |
| 空闲 CPU | < 1% | 悬浮动画必须用 CSS transform，不用 JS 定时器驱动 |

### 7.1 已识别的卡顿根因与对策

| 根因 | 现象 | 对策 |
|---|---|---|
| 每个 delta 触发一次 DOM 重建 | 长文本时掉帧 | 用 `requestAnimationFrame` 合并写入，单帧只 patch 一次 |
| 透明窗口每帧重绘整窗 | CPU 占用高 | 形象层用独立合成层（`will-change: transform`），动画只改 `transform`/`opacity` |
| 音频与文本各自计时 | 音画不同步 | 以 `audio.currentTime` 为唯一时钟驱动口型，不用定时器估算 |
| TTS 分多次合成拼接 | 句间停顿、音色跳变 | 用 `final` 全文一次合成（见 §4） |
| 窗口隐藏时定时器仍在跑 | 后台耗电 | 监听 `visibilitychange`，隐藏时暂停动画与轮询 |

## 8. 隐私与安全

- 组装层**不写入**任何用户对话内容到日志文件；日志只记录 `event_id`、状态迁移、错误码、耗时；
- 不包含任何统计/上报代码；若未来加入，必须默认关闭且首次启动明确告知；
- 不持久化 API 密钥；密钥只存在于上游模块自己的环境变量里；
- 渲染层对外部文本一律用 `textContent` 写入，禁止 `innerHTML`，防 XSS；
- 窗口默认 `alwaysOnTop` 但提供「勿扰模式」一键隐藏，避免打扰；
- 不做任何屏幕截图、不做全局键盘记录；快捷唤起使用系统级热键注册而非键盘钩子。

## 9. 技术选型结论（详见 `docs/selection-report.md`）

选择 **Tauri 2**，理由摘要：

1. 常驻内存与安装体积显著低于 Electron（本机实测数据见选型报告）；
2. 悬浮窗所需的置顶、透明、无边框、跳过任务栏、托盘均为 Tauri 原生能力；
3. 与「轻量、常驻内存小、跨平台」的需求直接对齐；
4. 前端仍是标准 Web 技术，形象渲染层可用 SVG/Canvas/Live2D，不受框架限制。

风险与对策：WebView2 依赖 Windows 10+ 已内置；Linux/macOS 使用系统 WebView，
渲染差异通过「形象层只用 CSS transform + Canvas 2D」规避。
