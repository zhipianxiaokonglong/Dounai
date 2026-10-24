# Dounai · 桌面悬浮窗

> 一款开源的 AI 情感助手——为孤独而有技术能力的你，提供有温度、且真正属于你自己的智能陪伴。

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-开发中-orange)

**本仓库是 Dounai 的「组装层 + 桌面悬浮窗」**：它把输入层、模型层、语音层三个独立模块
组装成一个常驻桌面的小伙伴，并负责所有面向用户的呈现。

---

## ✨ 项目简介

Dounai 是一款开源的 AI 情感助手。与传统聊天助手不同，我们在提供情绪价值的同时，
坚持把控制权和技术自由交还给用户：

- 🫂 **情绪价值**：带情感表达的语音交互、长期记忆、懂你所想的陪伴体验；
- 🛠 **技术能力**：多模态输入、多厂商模型接入、联网搜索、可编程提示词；
- 🔓 **开源开放**：核心模块全部开源，可独立部署、自由组合、自行魔改。

我们相信：**陪伴不该被垄断，模型不该被锁定，数据不该被上传。**

---

## 📦 模块地图

Dounai 是模块化产品，每个模块都可以独立运行、独立测试：

| 模块 | 职责 | 仓库 |
|---|---|---|
| 输入层 | 文字/图像/语音接入、声纹唤醒、多厂商适配 | [`Dounai_input`](https://github.com/zhipianxiaokonglong/Dounai_input) |
| 模型层 | 模型路由、提示词、上下文、联网检索、情感打标 | [`OmniNexus`](https://github.com/zhipianxiaokonglong/OmniNexus) |
| 语音层 | 标签驱动的情感 TTS、文本渲染切块、优雅降级 | MoodVoice |
| **组装层（本仓库）** | **事件编排、悬浮窗 UI、系统集成、用户文档** | **Dounai** |

本仓库**只通过约定的事件契约**与上游对接，不依赖其内部实现。契约见
[`docs/contracts.md`](docs/contracts.md)。

```text
你的输入 ──► 输入层 :8101 ──► 模型层 :8102 (SSE) ──► 语音层 :8103
                                   │                    │
                                   └──── 组装层（本仓库）◄┘
                                         悬浮窗 / 托盘 / 语音
```

---

## 🎯 目标用户

- 想要一个长期陪伴、有记忆、有温度的 AI 助手的你；
- 对技术有追求、不满足于"黑盒聊天框"的开发者与爱好者；
- 希望自主选择模型、掌控数据、深度定制的隐私敏感型用户。

---

## 🧩 本层能力

### 悬浮窗桌面宠物

- 无边框、透明、置顶、不占任务栏的常驻小窗；
- 默认形象为产品 logo，**形象渲染层可替换**，为后续正式形象预留；
- 四种状态：静默 / 唤醒 / 对话 / 情感（情感层预留状态位）。

### 事件编排

把三个上游的异步事件按 `session_id` / `event_id` 归并成一个「回合」：

- `delta` 用于即时上屏；`final` 是权威值，用于校正文本与标签；
- **用 `final` 的完整文本调用语音层**，而不是逐 delta 合成——
  这是避免音画不同步的关键（原因见 [`docs/architecture.md`](docs/architecture.md) §4）。

### 系统集成

| 能力 | 实现 |
|---|---|
| 托盘图标 | 显示/隐藏、勿扰、置顶、退出 |
| 窗口置顶 | 可开关 |
| 贴边吸附 | 24px 阈值 |
| 勿扰模式 | 静音 + 变灰 + 不主动弹窗 |
| 快捷唤起 | `Ctrl+Alt+D` / `Ctrl+Alt+Q` |

### 优雅降级

任何一个上游不可用都**不影响其他两个**：

| 不可用模块 | 体验 |
|---|---|
| 输入层 | 输入框禁用，徽标指明缺哪个 |
| 模型层 | 可输入但不发送，提示明确 |
| 语音层 | **文本照常显示**，仅标注语音不可用 |

---

## 🚀 快速开始

### 前置

- Node ≥ 20
- Rust ≥ 1.77 + MSVC 工具链（仅打包桌面应用时需要）
- Windows 10/11（自带 WebView2）；macOS/Linux 见 [`docs/selection-report.md`](docs/selection-report.md)

### 启动上游

三个上游需先运行。端口**必须错开**（输入层与模型层出厂默认都是 8000）：

```powershell
# 输入层
$env:DOUNAI_PORT = "8101"; dounai-input serve

# 模型层
$env:OMNI_PORT = "8102"; python -m omninexus

# 语音层
$env:EMOTION_TTS_PORT = "8103"; python -m emotional_tts serve
```

### 启动悬浮窗

```powershell
npm install

npm run dev        # 开发模式（Vite 代理，免 CORS 配置）
# 或
npm run build && npx tauri build   # 打包桌面应用
```

详细步骤、故障排查与隐私说明见 **[用户文档](docs/user-guide.md)**。

---

## 🔒 隐私承诺

**你的数据只属于你。**

- 对话数据、记忆库全部**本地存储，不上传网络**；
- 组装层**不记录对话内容**：日志只有状态、耗时、错误码与事件 UUID；
- **无任何统计上报**；若未来加入，必须默认关闭且明确告知；
- API 密钥**仅存于上游本地环境变量**，悬浮窗从不读取、不代管；
- 悬浮窗只连接 `127.0.0.1` 上的三个本地服务，无对外连接。

---

## 🏗 技术栈

| 项 | 选择 | 理由 |
|---|---|---|
| 桌面框架 | **Tauri 2** | 单文件约 8MB，对比 Electron 的 215MB；常驻内存更小 |
| 前端 | 原生 TypeScript + Vite | 无框架，减小体积与启动开销 |
| 形象渲染 | 可替换接口 + 默认 SVG | 为正式形象预留，与编排解耦 |
| 上游通信 | 主进程代理 | 绕开 CORS 且不削弱上游安全（见 [`docs/cors-and-proxy.md`](docs/cors-and-proxy.md)） |

选型过程与实测数据见 **[选型报告](docs/selection-report.md)**。

---

## 🗺 路线图

- [x] 核心对话链路（输入 → 模型 → 语音 → 呈现）
- [x] 悬浮窗四态与系统集成（托盘 / 置顶 / 吸附 / 勿扰 / 热键）
- [x] 可替换形象渲染层
- [x] 全链路集成测试与降级验证
- [ ] 正式助手形象（基于社区反馈推出）
- [ ] 情感表现层启用（状态位已预留）
- [ ] 提示词/人格可视化编辑

---

## 🧪 测试

```powershell
npm test           # 单元 + 集成（69 个用例）
npm run typecheck  # 类型检查
cargo test --release --manifest-path src-tauri/Cargo.toml
```

集成测试用**真实上游**跑完整链路，未启动时自动跳过。
实测数据、降级覆盖与根因分析见 **[测试报告](docs/TEST_REPORT.md)**。

---

## 📄 文档

| 文档 | 内容 |
|---|---|
| [用户文档](docs/user-guide.md) | 安装、使用、隐私、故障排查、更换形象 |
| [架构设计](docs/architecture.md) | 分层、状态机、降级矩阵、性能预算 |
| [事件契约](docs/contracts.md) | 与三个上游的完整接口约定 |
| [跨域与代理](docs/cors-and-proxy.md) | 为什么必须代理，以及如何实现 |
| [选型报告](docs/selection-report.md) | Electron vs Tauri 实测 |
| [同类调研](docs/research.md) | VPet / Shimeji / N0va / Desktop Goose / 豆包 / Raycast / uTools |
| [测试报告](docs/TEST_REPORT.md) | 测试范围、实测数据、根因分析 |

---

## 📜 License

本项目采用 **GNU General Public License v3.0**，详见 [LICENSE](LICENSE)。

> 🚧 项目正在开发中
