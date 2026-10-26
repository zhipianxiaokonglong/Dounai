# Dounai · 桌面悬浮窗

> 一款开源的 AI 情感助手——为孤独而有技术能力的你，提供有温度、且真正属于你自己的智能陪伴。

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-109%20passed-brightgreen)](docs/TEST_REPORT.md)
![Status](https://img.shields.io/badge/status-开发中-orange)

**本仓库是 Dounai 的「组装层 + 桌面悬浮窗」**：它把输入层、模型层、语音层三个独立模块
组装成一个常驻桌面的小伙伴，并负责所有面向用户的呈现。

> ## ⚠️ 重要公告：桌面端曾无法连接上游（已修复）
>
> 在 `0edb817` ~ `b5ac25b` 之间**构建过桌面应用**的用户请注意：
> 那段时间的 `dounai.exe` 能启动、有界面，但**所有对话请求都会失败**，
> 表现为一直显示「服务未连接」。**已在 `3623a02` 修复。**
>
> **如何判断是否中招**：同一版本用 `npm run dev` 正常、打包后不正常，就是这个问题。
>
> **怎么办**：重新 `git pull` 后重新打包（`npm run build && npx tauri build --no-bundle`），
> 旧的可执行文件请直接丢弃。仅用开发模式或只在源码层使用的用户**不受影响**。
>
> 完整说明（影响范围、根因、我们的验证失误、防复发措施）见
> **[事故说明](docs/incident-desktop-connection.md)**。

---

## 📦 模块地图

Dounai 是模块化产品，各模块独立运行、独立测试，且各自独立发布：

| 模块 | 职责 | 仓库 | 包名 |
|---|---|---|---|
| 输入层 | 文字 / 图像 / 语音接入、声纹唤醒、多厂商适配 | [`Dounai_input`](https://github.com/zhipianxiaokonglong/Dounai_input) | `dounai-input` |
| 模型层 | 模型路由、提示词、上下文、联网检索、情感打标 | [`OmniNexus`](https://github.com/zhipianxiaokonglong/OmniNexus) | `omninexus` |
| 语音层 | 标签驱动的情感 TTS、文本渲染切块、优雅降级 | [`MoodVoice`](https://github.com/zhipianxiaokonglong/MoodVoice) | `moodvoice-emotional-tts` |
| **组装层（本仓库）** | **事件编排、悬浮窗 UI、系统集成、用户文档** | **Dounai** | — |

本仓库**只通过约定的事件契约**与上游对接，不依赖其内部实现（契约见
[`docs/contracts.md`](docs/contracts.md)）。

```text
你的输入 ──► 输入层 :8101 ──► 模型层 :8102 (SSE) ──► 语音层 :8103
                                    │                    │
                                    └──── 组装层（本仓库）◄┘
                                          悬浮窗 / 托盘 / 语音
```

### 仓库边界

本仓库**自包含、可独立构建**：克隆后 `npm install && npm run build` 即可产出悬浮窗，
不需要任何其他仓库的源码（已用干净克隆验证：47 个文件、零外部路径引用）。

它**运行时不包含**三个上游，这是设计而非缺漏——上游通过 HTTP 契约对接：

| 需要什么 | 谁提供 | 本仓库是否包含 |
|---|---|---|
| 悬浮窗全部代码、构建脚本、图标、文档 | 本仓库 | ✅ 全部包含 |
| 三个上游的源码 | 各自公开仓库 | ❌ 按设计不包含，可自行克隆 |
| Node ≥ 20、Rust ≥ 1.77、WebView2 | 用户环境 | ❌ 工具链/系统组件 |
| npm 与 crates 依赖 | 包管理器按 `package.json` / `Cargo.toml` 拉取 | ❌ 不入库（`.gitignore` 已排除） |

> 只跑单元测试不需要任何上游；集成测试需要上游在运行，未启动时会自动跳过。
> 任一上游缺失都不是错误——组装层会降级显示，文本对话照常。

---

## 🎯 本层职责边界

**做**：

1. **接入**：把输入交给输入层，把输入事件交给模型层，把模型输出交给语音层；
2. **编排**：把三条上游的异步事件按 `session_id` / `event_id` 归并成一个「回合」；
3. **呈现**：驱动悬浮窗外观、流式文本、语音播放与口型；
4. **兜底**：任一上游不可用时优雅降级，绝不让 UI 崩溃或卡死。

**不做**（都不属于本层，避免把逻辑重复实现一遍）：

- ❌ 语音识别、声纹唤醒 → 输入层
- ❌ 模型路由、提示词、上下文、情感分类 → 模型层
- ❌ TTS 合成、情感风格映射、文本切块 → 语音层

---

## 🧩 本层能力

### 悬浮窗桌面宠物

- 无边框、透明、置顶、不占任务栏的常驻小窗；
- 默认形象为产品 logo；**形象渲染层可替换**，为后续正式形象预留；
- 四种状态：静默 / 唤醒 / 对话 / 情感（情感层预留状态位，本期只透传标签）。

### 事件编排

- `delta` 用于**即时上屏**；`final` 是**权威值**，用于校正文本与标签；
- **用 `final` 的完整文本调用语音层**，而不是逐 delta 合成——
  逐段合成会产生多次 TTS 调用、句间断裂与音色跳变，是音画不同步的主要根因
  （详见 [`docs/architecture.md`](docs/architecture.md) §4）。

### 三路输入

对应结构图「文字 / 图像 / 语音」三个入口，最终都归一成同一种事件：

| 入口 | 界面操作 | 走向 |
|---|---|---|
| 文字 | 输入框回车 | `POST /v1/inputs/text` |
| 图像 | 点 🖼 选图（PNG/JPEG/WebP/GIF） | `POST /v1/inputs/image`（multipart） |
| 语音 | 点 🎙 开始/停止录音 | `POST /v1/inputs/audio`（multipart，WebM） |

语音的转写文本会优先作为模型输入；`voiceprint_event == "wakeup"` 直接驱动唤醒态。

### 提示词切换

面板顶部可切换提示词配置（数据来自模型层 `GET /v1/prompts/profiles`）。
采用**每轮覆盖**语义，切换后下一轮即生效，不需要重建会话。
拿不到配置列表时静默回落到默认配置，不影响对话。

### 系统集成

| 能力 | 实现 |
|---|---|
| 托盘图标 | 显示 / 隐藏、勿扰、置顶、退出 |
| 窗口拖动 | 按住 logo 或面板标题栏空白处拖动（`data-tauri-drag-region="deep"`） |
| 窗口置顶 | 可开关 |
| 贴边吸附 | 距屏幕边缘 24px 内、**松手后**自动对齐（拖动中不吸附） |
| 勿扰模式 | 静音 + 形象变灰 + 不主动弹窗 |
| 快捷唤起 | `Ctrl+Alt+D` 唤起/收起、`Ctrl+Alt+Q` 勿扰 |
| 关闭即隐藏 | 点 × 只收起，进程由托盘常驻 |

### 优雅降级

任一上游不可用都**不影响其他两个**：

| 不可用模块 | 用户体验 |
|---|---|
| 输入层 | 输入框禁用，徽标指明缺哪一个 |
| 模型层 | 可输入但不发送，提示明确 |
| 语音层 | **文本照常显示**，仅标注「语音不可用」 |

降级是**逐模块独立**的：语音层挂掉不影响对话文本，输入层挂掉不影响已有内容回看。

---

## 🚀 快速开始

### 前置

- Node ≥ 20
- Rust ≥ 1.77 + MSVC 工具链（仅打包桌面应用时需要）
- Windows 10/11（自带 WebView2）

### 1. 启动三个上游

端口**必须错开**——输入层与模型层出厂默认都是 `8000`：

```powershell
# 输入层
$env:DOUNAI_DATA_DIR = "$PWD\.data"
$env:DOUNAI_PORT = "8101"
dounai-input serve

# 模型层（离线调试可启用自带的 echo 模型）
$env:OMNI_PORT = "8102"
python -m omninexus

# 语音层
$env:EMOTION_TTS_PORT = "8103"
python -m emotional_tts serve
```

自检：

```powershell
curl http://127.0.0.1:8101/healthz
curl http://127.0.0.1:8102/v1/healthz
curl http://127.0.0.1:8103/api/health
```

### 2. 配好模型（关键一步）

悬浮窗**不碰密钥**，模型全部由模型层提供。没配好的话，界面会提示
「还没有可用的模型」。

**最快跑通（零密钥）**：在模型层 `config/default.yaml` 里把 `echo` 段改成
`enabled: true`，重启模型层，然后在悬浮窗里发消息即可。`echo` 是离线诊断模型，
输出固定模板，用来验证链路。

**接真实厂商（BYOK）**：在**模型层仓库根目录**建 `.env`：

```powershell
cd <模型层仓库路径>
Copy-Item .env.example .env
notepad .env          # 填入 DEEPSEEK_API_KEY=sk-... 之类
python -m omninexus   # 必须在这个目录启动，.env 才读得到
```

验证：

```powershell
curl http://127.0.0.1:8102/v1/providers   # 你配的那家 available 应为 true
```

> 新手最容易踩的坑：**没在模型层根目录启动**，`.env` 读不到，
> 表现为所有模型 `available=false`。

完整教程（16 家厂商清单、本地 Ollama、语音厂商、排错清单）见
**[如何设置模型](docs/model-setup.md)**。

### 3. 启动悬浮窗

```powershell
npm install
npm run dev          # 开发模式：Vite 代理自动转发到三个上游
```

打包为桌面应用（**必须用 `tauri build`**）：

```powershell
npm run build                                  # 产出 dist/（前端资源）
npx tauri build --no-bundle                    # 把 dist 嵌入 exe
# 产物：src-tauri/target/release/dounai.exe  ≈ 7.9 MB
```

> ⚠️ **不要只用 `cargo build`**：那只会编译 Rust 壳，**不会把 `dist/` 嵌进去**，
> 得到的 exe 打开后是空白窗口。这是 Tauri 的资源嵌入机制决定的，不是配置问题。
>
> 要 NSIS 安装包就去掉 `--no-bundle`（需要联网下载打包工具）。

详细步骤、故障排查与隐私说明见 **[用户文档](docs/user-guide.md)**。

---

## 🗂 项目结构

```text
src/
├── contracts/      # 三个上游的事件契约解析（宽松、前向兼容）
├── upstream/
│   ├── transport.ts   # 传输层：主进程代理 / Vite 代理 两种模式
│   └── adapters.ts    # 三个上游的 HTTP 适配器 + SSE 收集器
├── orchestrator/   # 回合状态机、事件归并、降级决策
├── avatar/         # 可替换形象层（接口 + 注册表 + 默认 logo 实现）
└── ui/             # 悬浮窗渲染、设置、主进程桥接
src-tauri/
├── src/main.rs     # 窗口、托盘、快捷键、贴边吸附
└── src/proxy.rs    # 上游代理（仅允许回环地址）
tests/              # 契约 / 编排 / SSE 单测 + 真实上游集成测试
docs/               # 架构、契约、选型、调研、用户文档、测试报告
```

---

## 🔁 事件流与契约示例

模型层的 SSE 帧（真实格式，见 [`docs/contracts.md`](docs/contracts.md) §2）：

```text
event: meta
data: {"event_id":"…","session_id":"…","planned_model":"echo:echo"}

event: route
data: {"provider":"echo","model":"echo:echo","fallback":false}

event: delta
data: {"event_id":"…","session_id":"…","content":"增量","stream":true,
       "tags":{"emotion":"neutral","type":"text","intent":"reply"}}

event: final
data: {"event_id":"…","session_id":"…","content":"完整文本","stream":false,
       "tags":{"emotion":"comfort","type":"text","intent":"reply"}}
```

语音层的输出事件：

```json
{
  "event_id": "…",
  "text": "原文，逐字保持",
  "audio_ref": "/api/v1/audio/<hash>.mp3",
  "style": {"emotion": "comfort", "label": "安慰", "speed": 0.92, "tone": "温柔低缓"},
  "status": "synthesized",
  "degraded": false,
  "timings": {"first_chunk_ms": 836.7, "total_ms": 1163.1}
}
```

两个易踩的坑，本层已处理：

- `audio_ref` 是**相对路径**，必须拼语音层基址才能播放；
- 它是**临时引用**（缓存会过期/被清理），不能当历史消息的永久播放地址。

---

## 🔒 隐私承诺

**你的数据只属于你。**

- 对话数据、记忆库全部**本地存储，不上传网络**；
- 组装层**不记录对话内容**：日志只有状态、耗时、错误码与事件 UUID；
- **无任何统计上报**；若未来加入，必须默认关闭且首次启动明确告知；
- API 密钥**仅存于上游本地环境变量**，悬浮窗从不读取、不代管；
- 悬浮窗只连接 `127.0.0.1`，主进程代理强制校验回环地址，**无对外连接**。

---

## 🏗 技术栈

| 项 | 选择 | 理由 |
|---|---|---|
| 桌面框架 | **Tauri 2** | 单文件 7.94MB，对比 Electron 215MB（约 27 倍）；常驻内存更小 |
| 前端 | 原生 TypeScript + Vite | 无框架，产物仅 38.6KB，启动开销低 |
| 形象渲染 | 可替换接口 + 默认 SVG | 与编排解耦，为正式形象预留 |
| 上游通信 | 主进程代理 | 绕开 CORS 且**不削弱**上游安全策略（见 [`docs/cors-and-proxy.md`](docs/cors-and-proxy.md)） |

选型过程、实测数据与已知代价见 **[选型报告](docs/selection-report.md)**。

---

## 🧪 测试

```powershell
npm test           # 97 个用例（契约 / 编排 / SSE / 多模态 / 环境探测 / 全链路 / 降级）
npm run typecheck  # 类型检查
cargo test --release --manifest-path src-tauri/Cargo.toml   # 12 个 Rust 单测
```

| 套件 | 用例 | 覆盖内容 |
|---|---|---|
| `contracts` | 21 | 三个上游契约解析、前向兼容、坏数据 |
| `orchestrator` | 22 | 状态机、事件归并、幂等、降级、多模态、唤醒态 |
| `multimodal` | 11 | multipart 构造、图像/语音上传、提示词接口 |
| `sse` | 13 | 分帧、keep-alive、坏帧容错、失败序列 |
| `transport-mode` | 10 | **Tauri 2 环境探测**（防止桌面端退回浏览器直连） |
| `multimodal-live` | 6 | **真实上游**的图像/语音上传与提示词覆盖 |
| `full-chain` | 8 | **真实三模块**串完整链路（含音频可下载校验） |
| `degradation` | 6 | 指向死端口的真实降级 |
| Rust 单测 | 12 | 回环白名单、吸附几何（四角/阈值/双屏偏移） |

集成测试用**真实上游**，未启动时会明确打印跳过原因，不会误报失败。

**实测数据**（Edge 155 真实浏览器上下文）：

- 完整回合 input → SSE(37 个 delta) → TTS：约 2.8s，音频 46ms 解码、时长 17.088s
- 探活三模块并行：318ms
- 图像上传（经主进程代理）：返回 `modality=image` 与受控媒体 URL
- 提示词：列出 1 项配置；带 `prompt_profile` 的回合正常产出文本与语音

测试范围、降级覆盖与 5 个根因分析见 **[测试报告](docs/TEST_REPORT.md)**。

---

## ⚠️ 已知限制

诚实列出，避免误判为「已全部验证」：

| 限制 | 说明 |
|---|---|
| **窗口级交互未做真机验证** | 开发环境（DeepSeek Harness 会话）中 WebView2 运行时无法初始化，`msedgewebview2.exe` 启动即退出码 13。因此置顶、吸附、托盘、热键只完成**编译与单元级验证**。用户桌面（Win10/11 自带 WebView2）不受影响。 |
| Electron 对照基准无运行数据 | 该会话注入了 `ELECTRON_RUN_AS_NODE=1`，所有 Electron 进程被降级为纯 Node。选型报告中**如实标注为未取得**，未用估算值填充。 |
| 模型回答质量为模板 | 集成测试用模型层自带的离线 `echo` 模型，输出是固定模板。验证的是**链路与契约正确性**，不是回答质量。 |
| 跨平台仅验证 Windows | macOS / Linux 的移植策略见选型报告 §3，未实机验证。 |

---

## 🗺 路线图

- [x] 核心对话链路（输入 → 模型 → 语音 → 呈现）
- [x] 悬浮窗四态与系统集成（托盘 / 置顶 / 吸附 / 勿扰 / 热键）
- [x] 可替换形象渲染层
- [x] 全链路集成测试与降级验证
- [ ] **窗口级交互真机验证**（依赖可用的 WebView2 图形环境）
- [ ] 正式助手形象（基于社区反馈推出）
- [ ] 情感表现层启用（状态位已预留）
- [ ] 提示词 / 人格可视化编辑

---

## 📄 文档

| 文档 | 内容 |
|---|---|
| [**事故说明：桌面端无法连接上游**](docs/incident-desktop-connection.md) | **影响范围、根因、验证失误、恢复方法** |
| [**如何设置模型**](docs/model-setup.md) | **零密钥跑通、16 家厂商接入、本地 Ollama、语音厂商、排错清单** |
| [用户文档](docs/user-guide.md) | 安装、使用、隐私、故障排查、更换形象 |
| [架构设计](docs/architecture.md) | 分层、状态机、降级矩阵、性能预算 |
| [事件契约](docs/contracts.md) | 与三个上游的完整接口约定 |
| [跨域与代理](docs/cors-and-proxy.md) | 为什么必须代理，以及如何实现 |
| [选型报告](docs/selection-report.md) | Electron vs Tauri 实测与跨平台建议 |
| [同类调研](docs/research.md) | VPet / Shimeji / N0va / Desktop Goose / 豆包 / Raycast / uTools |
| [测试报告](docs/TEST_REPORT.md) | 测试范围、实测数据、根因分析 |

---

## 📜 License

本项目采用 **GNU General Public License v3.0**，详见 [LICENSE](LICENSE)。

> 🚧 项目正在开发中
