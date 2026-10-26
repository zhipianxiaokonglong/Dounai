# 测试报告

> 组装层是唯一面向最终用户的模块，质量标准高于其他层。本报告覆盖**全链路集成测试**
> （用三个上游模块的真实输出走完整链路）、降级场景、以及卡顿与音画不同步的**根因分析**。

测试环境：

| 项 | 值 |
|---|---|
| OS | Windows 11 专业工作站版 10.0.26200 |
| Node | v24.14.0 |
| Rust | 1.98.0 (x86_64-pc-windows-msvc) |
| 浏览器 | Edge 155.0.4283.62（真实 Chromium 上下文，非 jsdom） |
| 上游 | input :8101 / OmniNexus :8102（`echo:echo` 离线模型）/ output :8103（edge TTS） |
| 日期 | 2026-10-24 |

## 1. 测试总览

| 套件 | 用例数 | 结果 | 说明 |
|---|---|---|---|
| `tests/contracts.test.ts` | 21 | ✅ 通过 | 三个上游的事件契约解析、前向兼容、坏数据 |
| `tests/orchestrator.test.ts` | 22 | ✅ 通过 | 状态机、事件归并、幂等、降级、多模态、唤醒态 |
| `tests/multimodal.test.ts` | 11 | ✅ 通过 | multipart 构造、图像/语音上传报文、提示词接口 |
| `tests/sse.test.ts` | 13 | ✅ 通过 | SSE 分帧、keep-alive、坏帧、失败序列 |
| `tests/transport-mode.test.ts` | 10 | ✅ 通过 | **Tauri 2 环境探测**（防「桌面端退回直连」回归，见 §6.6） |
| `tests/integration/multimodal-live.test.ts` | 6 | ✅ 通过 | **真实上游**的图像/语音上传与提示词覆盖 |
| `tests/integration/full-chain.test.ts` | 8 | ✅ 通过 | **真实三模块**全链路 |
| `tests/integration/degradation.test.ts` | 6 | ✅ 通过 | 指向死端口的真实降级 |
| `src-tauri` Rust 单测 | 12 | ✅ 通过 | 回环白名单、吸附几何（左右上下四角/阈值/双屏偏移） |
| **合计** | **109** | **✅ 全部通过** | JS/TS 97 + Rust 12 |

浏览器端另有 CDP 驱动的端到端验证（见 §4），不纳入自动化计数，因为需要真实上游在线。

---

## 2. 全链路集成测试（真实模块）

不 mock 任何一层，直接打真实 HTTP：

```text
input:8101  →  OmniNexus:8102 (SSE)  →  output:8103  →  组装层
```

### 2.1 实测数据

| 环节 | 实测值 | 说明 |
|---|---|---|
| input 文字事件 | 约 10ms | 返回严格契约事件，`event_id` 为 UUID |
| OmniNexus SSE 首帧 | 约 100ms | `meta` 帧 |
| OmniNexus 全回合（echo 模型） | 192–249ms | 37–46 个 `delta` 帧 |
| output 合成（edge TTS） | 约 1100ms | `first_chunk_ms` 837ms，`total_ms` 1163ms |
| 组装层完整回合（input→llm→output） | 1404–2757ms | 含真实网络与 TTS 合成 |

### 2.2 已验证的契约事实

1. `delta` 是**增量**、`final` 是**完整替换值**；`final.content` 长度 ≥ 任一 delta（断言已覆盖）。
2. 帧顺序为 `meta → route → delta* → final`（断言已覆盖）。
3. `tags` 在 `delta` 上可能变化，`final` 才是权威值（编排器只取 final，断言已覆盖）。
4. 同一 `event_id` 重投返回同一 `output event_id`（幂等，断言已覆盖）。
5. `audio_ref` 是**相对路径** `/api/v1/audio/<hash>.mp3`，必须拼 `output` 基址（断言已覆盖）。
6. 音频文件可真实下载，且首字节为 MP3 帧同步头 `0xFF`（断言已覆盖，>1KB）。
7. `intent=tool` 时 `route.synthesize=false`、`audio_ref=null`（断言已覆盖）。

### 2.3 浏览器端真实渲染

在 Edge 155 的**真实 Chromium 上下文**中（CDP 驱动，非 jsdom）：

| 验证项 | 结果 |
|---|---|
| 三个上游探活 | input/llm/output 全部 true，318ms |
| SSE 解析 | 37 个 delta，249ms |
| 完整回合 | 2757ms，`state=talking`，`degraded=false` |
| 音频解码 | `<audio>` 触发 `loadedmetadata`，时长 **17.088s**，解码耗时 **46ms** |
| 状态收敛 | `notifyAudioEnded()` 后回到 `default` |

**音频 46ms 内可解码**，说明「有 URL 但播不出」的问题不存在。

---

## 3. 降级场景

用「指向 `127.0.0.1:9`（无监听）」模拟真实不可用，不 mock 函数。

| 场景 | 期望 | 实测 |
|---|---|---|
| `input` 不可用 | 进入 degraded，提示「输入服务未连接」 | ✅ |
| `OmniNexus` 不可用 | 不抛异常，提示「模型服务未连接」 | ✅ |
| `output` 不可用 | **文本完整保留**，仅无语音 | ✅ |
| 三者全不可用 | 不崩溃，稳定降级快照 | ✅ |
| 探活并行 | 总耗时不叠加（< 6s，串行需 9s） | ✅ 273ms |

### 3.1 output 失败时文本不丢

这是最容易做错的一点。验证方式：把 output 指向死端口，检查 `snapshot.text`：

```text
snapshot.text.length > 0   ✅   （文本来自 final，与 output 无关）
snapshot.audioUrl === null ✅   （没有假装有音频）
snapshot.degraded === true ✅   （UI 会显示「语音不可用」徽标）
```

**设计依据**：文本与语音是两条独立的呈现通道，`output` 只负责后者。

---

## 4. 根因分析

需求明确要求「从根源查起，不允许以重启/重试作为修复」。以下是本次发现的 5 个真实缺陷
及其根因，全部为**代码或配置层面的修复**，没有一处用「重启解决」。

### 4.1 【已修复】对话卡在「输入服务未连接」，但服务实际存活

**现象**：开发模式下 UI 显示 degraded、输入框禁用；但 `curl` 三个上游全部 200。

**排查路径**：

1. 直接 `fetch` 上游 → 浏览器报 `Failed to fetch`；
2. 用 Python 直接请求带 `Origin` 头 → `input`/`llm` 无 ACAO 头，`output` 直接 **403 `origin_not_allowed`**；
3. 查三个模块源码：`input` 注释写明「浏览器表单可写 localhost，不需要 CORS」；
   `OmniNexus` 的 `cors_origins` 默认空；`output` 有显式 Origin 白名单校验。

**根因**：三个上游的安全模型都假设「调用方是本地非浏览器进程」。WebView 直连必然被拦截。
而 `fetch` 在浏览器里把 CORS 失败与网络失败都报成同一句话，导致误判为「服务挂了」。

**修复**：改为**主进程代理**（`src-tauri/src/proxy.rs`）+ 开发模式 Vite 代理，
且代理必须**移除 `Origin`/`Referer`**（见 4.2）。修复后浏览器探活 318ms 全通。

### 4.2 【已修复】探活通过，但合成语音时 403

**现象**：修好 4.1 后，探活全绿，`input`/`llm` 正常，但 `output` 合成失败，提示「上游拒绝了跨域请求」。

**排查**：探活 `/api/health` 的成功与合成 `/api/v1/outputs` 的失败形成矛盾。
逐层验证发现：Python 经 Vite 代理请求合成**成功**，浏览器经同一代理**失败**。

**根因**：浏览器请求必带 `Origin: http://127.0.0.1:5173`；Vite 代理默认**透传**该头；
`output` 的白名单不含此来源 → 403。而探活接口不校验 Origin，所以探活是绿的同时合成为红。

**修复**：在 Vite 代理的 `proxyReq` 中 **removeHeader("origin"/"referer")**，
主进程代理同样不发送 Origin。语义上代理就是「本地进程调用」，这一修复是正确的而非绕过。

修复后同一浏览器上下文：`hasAudio=true`、`degraded=false`、音频 46ms 解码成功。

### 4.3 【已修复】SSE 收到 final 后仍永久等待，对话卡死

**现象**：`health` 三项全 true，`input` 成功，但 `llm` 阶段永久挂起，页面不报错。

**排查**：分段探针显示卡在 `step2 llm`。直接测原始 `fetch` 流：分片正常到达
（5267 → 3010 → 430 字节），且完整文本含 `meta:1 route:1 delta:46 final:1`。
说明**数据全到了，是读取循环不退出**。

**根因**：上游在发出 `final` 后**不关闭连接**（OmniNexus 为复用连接保持 keep-alive）。
组装层的读取循环以「读到 EOF」为结束条件，因此永远等不到 `done`。

**修复**：`requestStream` 的 `onChunk` 增加**终止信号**语义——收集器收到 `final` 或 `error`
即返回 `true`，传输层主动 `reader.cancel()` 释放连接，不再依赖 socket 关闭。

这条修复同时解决了「对话框像死了一样」这类最难复现的体验问题。

### 4.4 【已修复】view 层端点覆盖导致绕过代理

**现象**：4.1 修复后仍显示 degraded。

**根因**：`resolveEndpoints` 用 `{...代理地址, ...用户设置}` 合并，而用户设置里保存的是
绝对地址 `http://127.0.0.1:8101`，**覆盖**了代理前缀，于是又回到直连、又触发 CORS。

**修复**：dev-proxy 模式下**强制**返回 `/api/*` 前缀，忽略用户绝对地址（有意为之，
并在代码注释与 `docs/cors-and-proxy.md` 中说明）。修复后 UI 立刻进入 `default`、面板自动展开。

### 4.5 【已修复】降级标志残留，状态机无法回到 default

**现象**：单元测试发现——一轮降级结束后，状态永久停在 `degraded`，即使后续模块恢复。

**根因**：`notifyAudioEnded` / `notifyTextSettled` 用 `deriveState("default", health)`
计算静止态，但降级路径把 `health.output` 置为 false 后没有恢复；
同时 `degraded` 布尔值从未被重置。

**修复**：新增 `restingState()`，只依据 `input`/`llm` 两个**必需**模块的健康度决定静止态
（`output` 缺失属于可接受的降级，不应让整窗进入 degraded）；回合结束同时清除 `notice` 与 `degraded`。

**验证**：修复后 3 个原本失败的用例转绿。

### 4.6 音画不同步的专项设计（不是事后补丁）

| 潜在根因 | 对策 | 验证 |
|---|---|---|
| 逐 delta 调 TTS → 多次合成、句间断裂 | 用 `final` 全文一次合成 | 集成测试断言 output 收到 `final.content` |
| 用定时器估算语音进度 | 以 `audio.currentTime` / `AnalyserNode` 为唯一时钟 | 浏览器实测音频 46ms 解码、时长 17.088s |
| `final` 到达就切回默认态 | `talking → default` 只由 `audio ended` 触发 | 单元测试 3 例覆盖 |
| 每 token 重建 DOM → 掉帧 | `requestAnimationFrame` 合并写入，单帧只 patch 一次 | 代码审查 + 43 个快照不阻塞 |
| 透明窗每帧重绘 | 动画只改 `transform`/`opacity`，形象层独立合成层 | CSS 审查 |

---

## 5. 隐私与安全核查

| 检查项 | 方法 | 结果 |
|---|---|---|
| 日志不含对话内容 | 全局搜索 `console.log`，主进程日志只打印状态码与耗时 | ✅ |
| 日志不含密钥 | 代码中无任何密钥读取；密钥仅在上游环境变量 | ✅ |
| 无外传 | 代理层 `is_loopback_url` 白名单，仅允许 127.0.0.1/localhost/::1 | ✅ Rust 单测 2 例 |
| 无统计上报 | 全仓库无 telemetry / analytics 依赖 | ✅ |
| XSS | 渲染层统一 `textContent`，无 `innerHTML` 拼接用户文本 | ✅ 代码审查 |
| CSP | `tauri.conf.json` 限定 `default-src 'self'`，仅放行 127.0.0.1 | ✅ |

---

## 6. 结构图逐项核对

按项目结构图（部门四：总线与 UI 层）逐条核对实现状态：

| 结构图条目 | 状态 | 证据 |
|---|---|---|
| 桌面宠物悬浮窗 | ✅ | `src-tauri/src/main.rs`：无边框/透明/置顶/`skip_taskbar` |
| 托盘 | ✅ | 菜单四项：显示隐藏、勿扰、置顶、退出 |
| 置顶 / 吸附 | ✅ | `set_always_on_top` + `snap_to_edges`（24px） |
| 勿扰 | ✅ | 托盘项 + 状态变量 + 前端变灰/静音 |
| 快捷唤起 | ✅ | `Ctrl+Alt+D`、`Ctrl+Alt+Q`（主进程注册） |
| 状态机：默认→唤醒→对话→情感（预留） | ✅ | `UiState` 五值（含 degraded），`emotion` 为预留位 |
| 形象渲染层（可替换，一期 logo） | ✅ | `AvatarRenderer` 接口 + 注册表 + `LogoAvatarRenderer` |
| 消费输出事件 (event_id/text/audio_ref/style) | ✅ | `parseOutputEvent` + `applyOutput` |
| 文字输入 | ✅ | 输入框 → `/v1/inputs/text` |
| 图像输入 | ✅ **本次补齐** | 🖼 按钮 → `/v1/inputs/image`（multipart） |
| 语音输入 | ✅ **本次补齐** | 🎙 录音 → `/v1/inputs/audio`（WebM） |
| 声纹唤醒驱动唤醒态 | ✅ **本次补齐** | `voiceprint_event == "wakeup"` 分支 |
| 提示词操作（供 UI 调用） | ✅ **本次补齐** | 顶部下拉 + `GET /v1/prompts/profiles` + 每轮 `prompt_profile` |
| 失败降级 → 纯文本 | ✅ | `text_fallback` → 保留文本 + 徽标提示 |

### 6.1 本次核对中发现的缺口（已修复）

| 缺口 | 原状 | 修复 |
|---|---|---|
| UI 只有文字入口 | 结构图画了三路输入，实现只有一路 | 加图像/语音入口与对应适配器 |
| 声纹唤醒未驱动状态 | `wake()` 只有热键调用，注释与实现不符 | `submit` 内读 `voiceprint_event` |
| 提示词接口未接入 | 只在 `meta` 帧被动解析 `prompt_profile` | 新增列表接口 + 下拉 + 按轮覆盖 |
| 代理不支持二进制 | 主进程代理只能传字符串，无法上传文件 | 增加 `body_base64` 通道 |

新增 22 个用例覆盖上述改动（multimodal 11 + orchestrator 5 + live 6）。

### 6.2 隔离环境验收：从 GitHub 全新克隆跑通

为确认「用户按 README 操作能真实运行」，在一台机器的**隔离目录**（`D:\temp\dounai-verify`）
里从 GitHub 克隆四个仓库、按各自 README 从零安装，结果如下。

**环境搭建**

| 步骤 | 结果 |
|---|---|
| 克隆 4 个仓库 | ✅ Dounai 48 / Dounai_input 72 / OmniNexus 79 / MoodVoice 56 文件 |
| 三个 Python venv + 依赖安装 | ✅ 各自 README 的安装命令均成功 |
| 上游启动 | ✅ 8101 / 8102 / 8103 全部健康 |
| `npm install` + `typecheck` + `build` | ✅ 0 错误，dist 38.6KB |
| `npm test`（上游在线） | ✅ **87 项全过，零跳过** |
| `npx tauri build --no-bundle` | ✅ 产出 7.95MB exe |

**架构图逐项真实运行**

| 项 | 实测结果 |
|---|---|
| 输入事件契约 | ✅ 字段恰为 `{event_id, timestamp, modality, content, metadata}` |
| 图像输入 | ✅ 201，`modality=image`，`content` 为受控媒体 URL |
| 伪造图片 | ✅ 被拒 **HTTP 415**（魔数校验生效） |
| LLM 输出事件 | ✅ 帧序 `meta→route→delta×37→final`，字段与契约一致 |
| SSE final | ✅ `stream=false`，tags 为 `{emotion,type,intent}` |
| 输出事件 | ✅ 四要素齐全，`synthesized` 状态 |
| 音频真实可播 | ✅ 下载 21168 字节，首字节 `0xFF`（MP3 同步头） |
| 合成耗时 | ✅ 1130ms（首包 766ms） |
| 状态机 | ✅ 实测序列含 `wakeup → talking`，收敛回 `default` |
| 音频解码（浏览器） | ✅ `loadedmetadata` 成功，时长 17.088s，18ms |
| 情感标签透传 | ✅ `emotion/type/intent` 均正确传递 |
| 图像全链路 | ✅ input → 模型 → 语音 走通，文本 242 字 |
| 提示词接口 | ✅ 列出 `default`，按轮覆盖生效 |
| 界面控件 | ✅ 🖼 / 🎙 / 提示词下拉 均存在 |
| 语音层降级 | ✅ 文本保留 192 字、无音频、`degraded=true`，收敛回 `default` |
| 输入层降级头 | ✅ `X-Dounai-Degraded` / `Provider` / `Voiceprint-Checked` 齐全 |

**桌面应用窗口级验证**（此前受环境限制未完成，本次通过）

| 项 | 实测结果 |
|---|---|
| 应用启动 | ✅ 进程存活，主进程 32.1MB |
| 窗口可见 | ✅ `IsWindowVisible=true` |
| 窗口尺寸/位置 | ✅ 360×420，屏幕右下角 (1669, 660) |
| 界面真实渲染 | ✅ 上部面板区 3163 色、下部形象区亮占比 76.6%（非空白） |
| 前端 JS 执行 | ✅ 每次启动，OmniNexus 日志精确新增一条 `/v1/healthz` |
| ~~代理连通~~ | ❌ **当时结论错误，见 §6.6** |
| 进程树内存 | ✅ 8 个进程合计 404.1MB（主进程 32MB + WebView2 渲染进程） |

> ⚠️ **纠错（2026-10-26）**：上表「代理连通」一项当时判定为 ✅ 是**错误的**。
> 依据「OmniNexus 日志新增 `/v1/healthz`」只能证明**请求到达了服务端**，
> 无法证明**前端拿到了响应**——直连模式下请求同样会到达，只是响应被浏览器
> 的 CORS 规则丢弃。真实情况是桌面端一直走浏览器直连、探活全部失败。
> 详情与最终修复见 §6.6。

### 6.3 本次验收发现并修复的 2 个真实缺陷

| 缺陷 | 现象 | 根因 | 修复 |
|---|---|---|---|
| **窗口永不显示** | 应用启动后只有托盘图标，看不到悬浮窗；窗口尺寸 14×14 | `build_window` 用了 `.visible(false)`，但 setup 里**从未调用 `show()`**（只有托盘菜单的 toggle 会 show） | setup 末尾 `place_bottom_right()` + `window.show()` |
| **README 构建指令错误** | 按 README 的 `cargo build --release` 打包，exe 打开是空白窗口 | `cargo build` 只编译 Rust 壳，**不会把 `dist/` 嵌进 exe**；资源嵌入由 `tauri build` 完成 | README 改为 `npx tauri build --no-bundle`，并加警示说明 |

### 6.4 用户反馈：悬浮窗无法拖动（已修复）

用户实测反馈「窗口拖不动」。排查确认是**三个缺陷叠加**：

| 缺陷 | 说明 |
|---|---|
| 拖动区属性用错 | 代码里只有 Electron 的 `-webkit-app-region: no-drag`，**Tauri 不认这个属性**；正确做法是 `data-tauri-drag-region`。而且 `no-drag` 反而显式声明了「不可拖」 |
| 缺少权限 | `capabilities/default.json` 未声明 `core:window:allow-start-dragging` |
| 吸附逻辑打断拖动 | 旧实现在**每次 `Moved`** 都执行吸附，拖动途中一进入 24px 阈值就被拽回边缘 |

修复内容：

1. 给形象层、状态徽标、面板头部加 `data-tauri-drag-region="deep"`（子树任意位置可拖），
   按钮/输入框/下拉由 Tauri 自动豁免，不会误触发；
2. 补 `core:window:allow-start-dragging` 权限；
3. 吸附改为**松手后**执行：`Moved` 只更新序号，延迟 220ms 后若序号未变才吸附
   （即「最后一次移动」判定为拖动结束）；
4. 点击 vs 拖动：Tauri 在 `mousedown` 会 `stopImmediatePropagation()` 吞掉 `click`，
   因此形象层的展开面板改判 `pointerdown`/`pointerup` 位移（<5px 且 <400ms 才算点击）；
5. CSS 用 `cursor: move` 提示可拖，移除无效的 `-webkit-app-region`。

**验证结果**：用户手动验证拖动已正常。

**回归测试**：吸附几何逻辑抽成纯函数 `snap_position()`，新增 8 个 Rust 单测覆盖
左/右/上/下/四角吸附、阈值边界、第二显示器偏移，以及核心回归用例
`dragging_away_from_edge_is_not_snapped_back`（验证离开阈值不再被吸回）。
Rust 测试从 4 项增至 12 项，全部通过。

> **自动化局限（如实记录）**：用 `mouse_event` 合成的鼠标消息**不会触发 WebView2 的
> DOM 指针事件**，因此脚本化拖拽测试对本功能无效（表现为「窗口没动」的假失败）。
> 拖动这一项必须以人工操作验证。合成输入不产生 WebView2 指针事件是已知行为。

### 6.5 用户反馈：托盘出现两个图标（已修复）

用户反馈「右下角出现两个相同图标，一个能点、一个不能点」。

**排查过程（含一次错误假设）**：

1. 初次假设：`tauri.conf.json` 的 `app.trayIcon` 会让 Tauri 在 setup 前自动建一个
   id=`main` 的托盘，代码里 `TrayIconBuilder::with_id("main")` 又建一个，同 id 冲突产生两个。
   读 `tauri-2.12.5/src/app.rs:2589` 确认了「配置会自动创建托盘」这一机制存在。
2. **对照实验推翻了部分假设**：分别构建「带 trayIcon 配置」与「不带配置」两个版本，
   用 Win32 `EnumWindows` 统计 `tray_icon_app` 窗口类实例数 —— **两者都是 1 个**。
   说明配置重复创建**并不成立**（Tauri 在 setup 前后只会建一个）。
3. 继续定位：连续启动两次应用，发现**进程数仍是 1** —— 但那是因为第二次启动的新进程
   瞬间退出、旧进程还在。真正的问题是**没有单实例保护**：
   用户重复双击图标会叠加多个进程，每个进程各占一个托盘图标；
   后来那个实例往往没抢到焦点，看起来就是「一个能点、一个不能点」。

**最终修复**：

1. 加入 `tauri-plugin-single-instance`，第二次启动时把已有窗口 `show + set_focus + unminimize`
   并广播 `dounai://wake`，而不是起新进程；
2. 顺手删掉 `tauri.conf.json` 里冗余的 `trayIcon` 配置（托盘统一由代码创建，带菜单与事件），
   并在 `build_tray()` 开头加 `tray_by_id("main").is_some()` 早退检查，防止将来再被重复创建；
3. 托盘 tooltip 与交互改进：左键单击/双击都切换窗口，右键弹菜单。

**验证结果**（`EnumWindows` 统计 `tray_icon_app`）：

| 场景 | 进程数 | tray_icon_app |
|---|---|---|
| 首次启动 | 1 | 1 |
| 再次启动（模拟重复双击） | 1 | 1 |
| 再次启动后前台窗口 | 属于已有 PID | — |

`Tauri Window` / `tray_icon_app` / `global_hotkey_app` / `com.dounai.desktop-sic`（单实例锁）
各 1 个，主进程内存 32.6MB，说明修复未破坏托盘、热键与窗口。

### 6.6 桌面端无法连接上游（外部 PR #1 修复）

**这是本报告此前最大的验证失误，必须记下来。**

**现象**：打包后的 `dounai.exe` 启动后显示「服务未连接」，即使三个上游都在运行；
浏览器 dev 模式（Vite 代理）完全正常，只在桌面端复现。

**根因（两条叠加）**：

| 缺陷 | 说明 |
|---|---|
| `tauri.conf.json` 未设 `withGlobalTauri` | 该字段默认 `false`（见 `tauri-utils-2.10.2` 的 `Default`），所以 `window.__TAURI__` **从未注入** |
| 前端读取的是 Tauri 1 的结构 | Tauri 2 把 `invoke` 放在 **`__TAURI__.core.invoke`**；`bundle.global.js` 末尾 `e.core=g` 可证。代码里取 `__TAURI__.invoke` 永远是 `undefined` |

两者叠加 → `tauriInvoke()` 返回 `null` → 前端退回**浏览器直连** → 被上游 CORS 拦截：

| 模块 | 直连（带 Origin）结果 |
|---|---|
| `input` | 200，但**无 ACAO 头** → 浏览器丢弃响应 |
| `llm` | 200，但**无 ACAO 头** → 浏览器丢弃响应 |
| `output` | **403**（Origin 白名单直接拒绝） |

**为什么之前没被发现（我的失误）**：

我把「OmniNexus 日志里新增一条 `/v1/healthz`」当成了「前端经代理连通成功」的证据。
这个推断不成立：**直连时请求同样会到达服务端**，CORS 是浏览器**读取响应**时才拦截的。
只验证了「请求发出」，没验证「响应被接受」。

**修复**（由贡献者 Tonyjh07 提交的 PR #1，已合并为 `4af37b8`）：

1. `tauri.conf.json` 开启 `"withGlobalTauri": true`；
2. `transport.ts` / `bridge.ts` 改为 `__TAURI__.core?.invoke ?? __TAURI__.invoke`（兼容 Tauri 1）；
3. 补充修复（本次）：`runtime.detectRuntime()` 统一以「invoke 是否可调用」为判据，
   与 `transportMode()` 口径一致，避免两处判定打架。

**同根因的连带影响**（此前后果被低估）：`bridge.ts` 依赖 `__TAURI__.event`，
它同样未注入，因此托盘「勿扰模式」广播、面板可见性联动此前**全部失效**；
修复后一并恢复。

**回归测试**：新增 `tests/transport-mode.test.ts`（10 项），覆盖 Tauri 2 结构、
Tauri 1 兼容、`__TAURI__` 存在但无 invoke 的中间态、无全局、null 值，以及
`detectRuntime()` 与 `transportMode()` 口径一致性。

已验证该测试能守住 bug：**同一批用例在修复前失败、修复后通过**：

```text
修复前: × __TAURI__.core.invoke 存在时判定为 proxy
        → expected 'direct' to be 'proxy'
修复后: ✓ 10 passed
```

**教训**：验证「连通性」必须看**客户端是否接受了响应**，不能只看服务端是否收到请求。
在浏览器/WebView 语境下，这两件事是分离的。

---

## 7. 已知限制

1. ~~**GUI 窗口无法在本机启动**~~ —— **已在 §6.2 突破**：隔离环境里应用成功启动，
   窗口 360×420 可见、界面真实渲染、前端 JS 执行。
   ⚠️ 但「经代理连通上游」一项当时判断有误，真实情况与修复见 §6.6。
   早前启动失败的原因是当时会话的 WebView2 初始化受限；换到独立目录重新打包后正常。
   仍未做人工点按验证的项目见下方第 2、3 条。
2. **语音录音未做真人点按验证**：`MediaRecorder` 需要麦克风权限与可用音频设备。
   上传链路已用真实 WAV/WebM 跑通（见 `multimodal-live`），缺的是「按 🎙 录音」这一步的设备交互。
3. **托盘菜单与热键未做人工点按验证**：菜单四项与 `Ctrl+Alt+D` / `Ctrl+Alt+Q` 已注册成功、
   编译通过，但需要人工在桌面点击确认。这类交互无法用脚本可靠断言。
4. **Electron 对照基准未能取得运行数据**：会话注入 `ELECTRON_RUN_AS_NODE=1`，
   任何 Electron 进程都被降级。已在选型报告中如实披露，未用估算值替代。
5. `echo:echo` 是离线诊断模型，其输出是固定模板而非真实 LLM 回答。因此本报告验证的是
   **链路与契约正确性**，不是「模型回答质量」。
6. edge TTS 需要外网访问微软服务；离线环境下 output 会走 `text_fallback`，
   该路径已由降级测试覆盖。

---

## 8. 复现方式

```powershell
# 1) 启动三个上游（详见 tests/integration/README.md）
#    input :8101 / OmniNexus :8102（echo 启用）/ output :8103

# 2) 单元 + 集成测试
npm test

# 3) Rust 单测
cargo test --release --manifest-path src-tauri/Cargo.toml

# 4) 前端构建与类型检查
npm run typecheck
npm run build
```
