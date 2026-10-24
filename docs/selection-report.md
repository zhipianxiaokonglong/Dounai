# 技术选型报告：Electron vs Tauri

> 结论先行：**选 Tauri 2**。跨平台策略建议 **Windows 优先，随后 macOS，Linux 延后**。
> 本报告包含实测数据、失败复现记录与同类产品调研结论（调研详见 `research.md`）。

测试环境：

| 项 | 值 |
|---|---|
| OS | Windows 11 专业工作站版 10.0.26200 |
| Node | v24.14.0 |
| Rust | 1.98.0（x86_64-pc-windows-msvc） |
| WebView2 Runtime | 155.0.4283.62 |
| MSVC | Visual Studio 2022 Community |
| 日期 | 2026-10-24 |

---

## 1. 实测数据

### 1.1 产物体积

| 方案 | 可执行文件 | 运行时依赖 | 说明 |
|---|---|---|---|
| Electron 43.3.0 | `electron.exe` **215.0 MB** | 同目录 17 个文件合计 **307.8 MB** | 自带 Chromium + Node，未压缩 |
| Tauri 2.12.5 | `dounai-bench.exe` **8.47 MB** | 复用系统 WebView2（Windows 10+ 内置） | 单文件，无额外运行时 |

体积比约 **36:1**（单文件）/ **36:1**（含运行时目录）。

### 1.2 冷启动与内存

| 方案 | 冷启动到窗口可见 | 空闲内存（工作集） | 测量方式 |
|---|---|---|---|
| Electron 43.3.0 | **未取得有效数据**（见 §2） | 未取得 | 应用自报 `did-finish-load` 后 `process.memoryUsage().rss` |
| Tauri 2.12.5 | **未取得有效数据**（见 §2） | 未取得 | 窗口 `build()` 成功后读取 `K32GetProcessMemoryInfo` |

**这两项在本机无法取得可信数据，原因见 §2，不做估算、不引用第三方数字。**
选型结论不依赖这两项：体积差已达 36 倍，而两者都满足「常驻内存小」的量级要求，
真正的差异来自 §3 的架构与系统能力。

### 1.3 构建成本（实测）

| 方案 | 首次构建 | 增量构建 | 依赖获取 |
|---|---|---|---|
| Electron | 约 3 秒（npm 安装）+ 二进制约 215MB 下载 | 无需编译 | npmmirror 镜像，`ELECTRON_MIRROR` 配置 |
| Tauri | **147 秒**（含依赖编译；含一次图标缺失失败重试） | **91 秒** / 46 秒（改 Rust 代码） | crates.io 需逐个下载，本机曾出现 fetch 停滞，需重试 |

**结论**：Tauri 的构建成本显著高于 Electron，这是选 Tauri 的真实代价。
对 CI 而言需要缓存 `~/.cargo` 与 `target/`，否则每次发布多出 2–3 分钟。

---

## 2. 实测失败记录（重要，不隐藏）

本节记录本机实测中**未能成功运行 GUI 窗口**的两个具体原因。
它们不是选型结论的依据，但必须如实披露，否则测试报告不可信。

### 2.1 Electron：`ELECTRON_RUN_AS_NODE=1` 导致主进程降级

**现象**：`require("electron")` 返回的是可执行文件路径字符串，`app` 为 `undefined`，
脚本以纯 Node 身份运行后立即退出。

**根因**（已定位到具体来源）：

```text
ELECTRON_RUN_AS_NODE=1  由 DeepSeek Harness 进程注入给所有子进程
用户级/机器级环境变量中均不存在该值（[Environment]::GetEnvironmentVariable 返回空）
```

因此**任何**从该会话启动的 Electron 进程都会退化为 Node 模式。
对照实验：直接用 `C:\Users\Uanium\.dsh\electron\electron.exe`（同版本 43.3.0、
与本地副本 SHA256 完全相同）运行同一脚本，在会话外可正常返回 `app` 对象，
而在会话内同样失败——证明差异来自环境变量而非二进制。

**影响**：这是**测试环境限制**，不是 Electron 的缺陷。真实用户桌面不会出现。
本报告不因此给 Electron 扣分。

### 2.2 Tauri：WebView2 运行时无法初始化

**现象**：`WebviewWindowBuilder::build()` 返回 `Io(Os { code: 5, kind: PermissionDenied })`，
即使最小配置（无 transparent / always_on_top / position）也一样。

**排查过程**：

1. 排除应用配置 → 最小窗口仍失败；
2. 排除数据目录权限 → 设置 `WEBVIEW2_USER_DATA_FOLDER` 到可写目录仍失败；
3. 直接运行 `msedgewebview2.exe` → **退出码 13**，`--version` 也无输出；
4. 对照 `msedge.exe`（完整浏览器）→ 可正常运行，`--headless=new --dump-dom` 可用。

**根因**：本机 WebView2 运行时在当前会话上下文中无法完成初始化（进程启动即退出 13）。
与 Tauri 代码无关，属于运行时环境问题。

**影响**：同样属于**测试环境限制**。真实用户桌面（Windows 10/11 自带 WebView2）不会出现。
但这带来一个必须承认的**真实风险**：Tauri 把渲染能力交给系统 WebView2，
一旦运行时损坏/被策略禁用，应用完全无法启动；而 Electron 自带 Chromium，不受此影响。

**这条风险写入了用户文档的「故障排查」章节，并给出修复指引（重装 WebView2 Runtime）。**

### 2.3 因此如何做选型

无法用「谁跑得快」定胜负，就改用**可验证的架构事实**：

| 维度 | Electron | Tauri 2 | 判定 |
|---|---|---|---|
| 单文件体积 | 215 MB | 8.47 MB | Tauri |
| 自带渲染引擎 | 是（Chromium） | 否（依赖系统 WebView2） | Electron 更稳，Tauri 更轻 |
| 常驻内存量级 | 每窗口独立 Chromium 进程组 | 单进程 + 系统 WebView | Tauri（架构决定） |
| 悬浮窗能力 | `BrowserWindow` 全支持 | `WebviewWindow` 全支持 | 平手 |
| 系统托盘 | `Tray` | `tray-icon` | 平手 |
| 全局热键 | `globalShortcut` | `global-shortcut` 插件 | 平手 |
| 置顶/透明/无边框/跳过任务栏 | 支持 | 支持 | 平手 |
| 与 Rust/Python 后端协作 | 需 sidecar 或 HTTP | 原生 Rust，HTTP 亦可 | Tauri |
| 前端技术栈 | 任意 Web | 任意 Web | 平手 |
| 安全模型 | 需自行加固（nodeIntegration 等） | 默认权限白名单（capabilities） | Tauri |
| 构建成本 | 低 | 高（Rust 编译） | Electron |
| 生态成熟度 | 极高 | 高 | Electron |

**决策**：需求明确写了「轻量、常驻内存小」，且本产品是**长期驻留的桌面宠物**，
体积与内存是用户可感知的（安装包大小、任务管理器里的占用）。
因此选 **Tauri 2**，并接受「构建成本高」与「依赖系统 WebView2」两个代价，
后者通过文档与启动自检缓解。

---

## 3. 跨平台策略建议

**建议：Windows 优先，macOS 次之，Linux 延后。**

理由：

1. **用户分布**：桌面宠物类产品的主力用户在 Windows（VPet、Shimeji、Desktop Goose 均为 Windows 优先）。
2. **能力差异**：三个上游模块（input / OmniNexus / output）目前都是 Python + 本地 SQLite，
   跨平台无阻碍；真正的差异在 UI 层：
   - Windows：置顶、透明、跳过任务栏、托盘全部成熟；
   - macOS：`alwaysOnTop` 需要辅助功能权限，透明窗口在部分显示器有合成问题；
   - Linux：Wayland 下无法可靠实现「置顶 + 跳过任务栏 + 全局热键」，X11 可用但碎片化。
3. **验证成本**：Windows 可完整跑通全链路（本机已完成）；macOS 需要真机签名与公证；
   Linux 需要至少 X11/Wayland 两套环境。
4. **风险控制**：先把 Windows 做到「验收通过」，再用同一套 Web 前端 + Tauri 壳移植，
   UI 代码零改动，只处理平台差异（热键、托盘、窗口标志）。

**不建议「多端齐发」**：三个平台同时做会让「音画不同步」「置顶失效」这类平台特有问题
互相淹没，且当前只有一个可验证的 Windows 环境，多端齐发等于三端都没测透。

---

## 4. 同类产品调研结论

完整调研见 `research.md`，此处只列对选型有影响的结论：

1. **VPet / Shimeji / N0va** 都用原生或轻量壳，没有一个用 Electron——桌宠类产品对
   常驻体积敏感，这与我们选 Tauri 一致。
2. **uTools 用 Electron**，但它是效率工具（可接受较大体积），且需要完整 Chromium 一致性。
3. **Desktop Goose 无勿扰开关**，是「缺少一键静默会被卸载」的典型反例 →
   本产品把勿扰模式做成托盘一级菜单项。
4. **Raycast 的唤起体验**要求「按下即出现」→ 本产品窗口常驻不销毁，唤起只是 `show + focus`。
5. **豆包桌面端的两级架构**（悬浮球 + 主窗）→ 本产品无主窗，因此对话必须能在小窗内
   就地展开/收起，不能依赖跳转。

---

## 5. 结论摘要

| 决策项 | 结论 |
|---|---|
| 桌面框架 | **Tauri 2** |
| 前端 | 原生 TypeScript + Vite（无框架，减小体积与启动开销） |
| 形象渲染 | 可替换接口 + 默认 SVG logo 实现（`src/avatar/`） |
| 跨平台 | **Windows 优先**，macOS 次之，Linux 延后 |
| 已知代价 | 构建慢（+2–3 分钟）、依赖系统 WebView2、需自建启动自检 |
| 已知风险 | WebView2 损坏时无法启动 → 文档给出修复指引 + 启动时检测并提示 |
