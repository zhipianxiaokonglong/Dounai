# 安全策略

本文件说明 Dounai 组装层（桌面悬浮窗）的安全边界、漏洞披露渠道与响应时限。

---

## 1. 适用范围

本仓库是 Dounai 的**组装层 + 桌面悬浮窗**（模块 D）。它通过 HTTP 事件契约与三个上游模块对接：

| 模块 | 仓库 | 是否在本仓库范围内 |
|---|---|---|
| 输入接入层 | `Dounai_input` | ❌ 各自仓库 |
| LLM 编排核心 | `OmniNexus` | ❌ 各自仓库 |
| 输出表达层 | `MoodVoice` | ❌ 各自仓库 |
| 组装层 + UI | 本仓库 | ✅ |

**上游模块的漏洞请提交到对应仓库**（它们各自维护 `SECURITY.md`）。
若不慎提错位置，我们会转交，但响应时限从转交后起算。

---

## 2. 报告漏洞

**请不要在公开 Issue 中披露漏洞细节。**

优先使用 GitHub 的私密渠道：

> **Security → Advisories → Report a vulnerability**
> <https://github.com/zhipianxiaokonglong/Dounai/security/advisories/new>

如果该入口不可用，可开一个**不含技术细节**的 Issue，说明"需要安全联系方式"，
我们会主动建立私密通道。

### 2.1 报告里请包含

| 项 | 说明 |
|---|---|
| 受影响版本 | commit hash 或 Release 版本 |
| 运行环境 | OS 版本、是否打包运行（`dounai.exe`）还是 `npm run dev` |
| 复现步骤 | 最小可复现步骤 |
| 影响 | 能做什么（命令执行？数据读取？崩溃？） |
| 概念验证 | 可选，但很有帮助 |

**不要**在报告里附带真实用户数据、真实 API 密钥或对话内容。

### 2.2 我们承诺

- 收到报告后 **3 个工作日内**确认收到；
- 修复后发布安全公告，并在公告中致谢（除非你要求匿名）；
- 不因善意报告采取法律行动。

---

## 3. 响应时限（SLA）

按 CVSS 分级：

| 等级 | CVSS | 响应 | 修复目标 |
|---|---|---|---|
| Critical | ≥ 9.0 | 24 小时内 | 尽快，通常 ≤ 7 天 |
| High | 7.0 – 8.9 | 72 小时内 | ≤ 14 天 |
| Medium | 4.0 – 6.9 | 7 天内 | 下一版本 |
| Low | < 4.0 | 14 天内 | 视情况 |

**上架门槛**：Critical 与 High（CVSS ≥ 7.0）未修复时**不得发布**。

---

## 4. 本层的安全边界

### 4.1 我们防什么

| 类别 | 措施 | 位置 |
|---|---|---|
| 上游地址滥用（SSRF） | 代理只接受回环地址，`file://`/`ftp://`/外部主机一律拒绝 | `src-tauri/src/proxy.rs` 的 `is_loopback_url` |
| 前端越权访问网络 | CSP `connect-src 'self' http://127.0.0.1:*`，双层收口 | `src-tauri/tauri.conf.json` |
| XSS（上游返回恶意文本） | 渲染层统一 `textContent`，不用 `innerHTML` 拼接用户文本 | `src/ui/main.ts` |
| 契约漂移导致崩溃 | 宽松解析器：忽略未知字段、必填缺失才报错 | `src/contracts/index.ts` |
| 上游异常拖垮 UI | 逐模块降级，任一不可用不影响其他 | `src/orchestrator/index.ts` |
| 重复实例叠加 | 单实例锁 | `tauri-plugin-single-instance` |
| 二进制上传被当作字符串注入 | 代理走 `body_base64` 解码后原样转发，Content-Type 由前端给出 | `src-tauri/src/proxy.rs` |

### 4.2 权限模型

Tauri 的 capabilities 为**最小权限集**，只开放：

```text
core:default
core:window:allow-show / allow-hide / allow-set-focus / allow-start-dragging
```

未开放文件系统、Shell、进程调用、任意 HTTP。`withGlobalTauri` 只是把 API 挂到
`window.__TAURI__`，所有 invoke 仍要过 Rust 侧权限校验。

### 4.3 我们**不**防什么（明确边界）

- **上游模块本身的漏洞**：模型层收到的恶意响应、语音层的 TTS 厂商调用，属于各自仓库范围；
- **用户自行修改的地址**：用户可把端点改到局域网/公网地址，这是用户的选择，
  但代理的 `is_loopback_url` 仍会拒绝——要连外部地址需自行调整并承担风险；
- **宿主机层面的攻击**：本层不做进程沙箱、不防本地提权。

### 4.4 已知的非漏洞

以下行为**不是**漏洞，无需报告：

| 行为 | 说明 |
|---|---|
| 浏览器 dev 模式下直连上游失败 | 上游不给浏览器跨域开口子，属设计（见 `docs/cors-and-proxy.md`） |
| 语音层返回 403 `origin_not_allowed` | 它的来源白名单机制，正常防护 |
| 上游未启动时界面显示"服务未连接" | 预期的降级表现，不是崩溃 |
| `audio_ref` 过期打不开 | 缓存有生命周期，文档已说明 |

---

## 5. 数据处理声明

本层**不处理也不存储**用户的敏感数据：

- **不记录对话内容**：日志只有状态、耗时、错误码、事件 UUID；
- **不保存任何 API 密钥**：密钥只存在于上游模块的环境变量；
- **无统计上报**：不集成任何遥测/分析 SDK；
- **无外部网络请求**：CSP 与代理双层限制，只连 `127.0.0.1`。

> 唯一可能的外部流量来自**语音层**（它按你选择的 TTS 厂商发送文本），
> 那属于 `MoodVoice` 的隐私边界，不在本层。

---

## 6. 依赖与供应链

| 项 | 现状 |
|---|---|
| 依赖锁定 | `package-lock.json` 与 `Cargo.lock` 均已入库 |
| 依赖审计 | 建议定期运行 `npm audit` 与 `cargo audit`（本层尚无 CI 强制） |
| 构建产物 | 由本仓库源码直接构建，不下载预编译第三方二进制（除 Electron/Tauri 官方工具链） |

> 本层目前**没有** CI 强制执行依赖审计与静态扫描。这是已知的工程缺口，
> 补齐后将更新本节。

---

## 7. 不在范围内

- 本项目当前**没有**赏金计划；
- 不提供 PGP 邮件通道，请走 GitHub Advisories；
- 安全公告发布在仓库 Releases 与 Advisories。

---

## 8. 安全相关文档

| 文档 | 内容 |
|---|---|
| [跨域与代理](docs/cors-and-proxy.md) | 为什么必须经主进程代理、CORS 边界 |
| [事件契约](docs/contracts.md) | 上游输入的可信边界 |
| [事故说明](docs/incident-desktop-connection.md) | 一次真实缺陷的完整复盘 |
| [隐私承诺](README.md#-隐私承诺) | 面向用户的数据处理声明 |
