# 出网白名单

> 对应任务书 §5.5「出网白名单公开给用户查阅」。
> **本层（组装层 + 桌面悬浮窗）不产生任何外部网络请求。** 本文说明依据与验证方法。

---

## 1. 结论

| 项 | 值 |
|---|---|
| 出网域名白名单 | **空集**（无外部域名） |
| 允许的连接 | 仅 `127.0.0.1`（回环），端口 `8101` / `8102` / `8103` |
| 默认是否联网 | **否** |
| 是否有遥测/上报 | **无** |

本层是一个纯本地的组装壳：它只跟你机器上已启动的三个上游模块通信。
所有外部访问（LLM 厂商、TTS 厂商）都发生在**上游模块内部**，由其各自的配置与文档负责。

---

## 2. 双层收口（为什么可以确认没有外部请求）

只写一句"我们不联网"是不够的，这里给出**两层独立限制**：

### 2.1 前端层：CSP

`src-tauri/tauri.conf.json` 里的内容安全策略：

```text
default-src 'self'
connect-src 'self' http://127.0.0.1:*      ← 只允许本机
media-src   'self' blob: http://127.0.0.1:* ← 音频也只从本机取
img-src     'self' data: blob: http://127.0.0.1:*
```

浏览器/WebView 层面，任何指向非 `127.0.0.1` 的 `fetch` / `XMLHttpRequest` /
`<audio src>` 都会被这条策略**直接阻断**，请求不会发出。

### 2.2 主进程层：代理白名单

前端的所有上游请求都经 Rust 主进程代理转发
（原因见 [`docs/cors-and-proxy.md`](docs/cors-and-proxy.md)），而代理有独立的主机校验：

```rust
// src-tauri/src/proxy.rs
fn is_loopback_url(url: &str) -> bool {
    // 只接受 http/https，且主机必须是：
    //   127.0.0.1 / localhost / ::1 / [::1] / 0.0.0.0
}
```

即便有人绕过前端 CSP 直接调用 `upstream_request` 命令，非回环地址也会被拒绝，
返回 `forbidden`。这条规则有单元测试覆盖（`proxy::tests`）。

**两层是独立的**：CSP 拦在 WebView，代理白名单拦在 Rust，任一层都能单独挡住外部请求。

---

## 3. 你可以自己验证

### 3.1 静态验证（读代码）

```powershell
# 1) 看 CSP 是否只放行本机
Select-String -Path src-tauri/tauri.conf.json -Pattern 'connect-src'

# 2) 看代理是否只允许回环
Select-String -Path src-tauri/src/proxy.rs -Pattern 'is_loopback_url' -Context 0,12

# 3) 搜代码里有没有外部地址（应只剩 SVG 命名空间与测试数据）
Get-ChildItem -Recurse -Include *.ts,*.rs |
  Select-String -Pattern 'https?://' |
  Where-Object { $_.Line -notmatch '127\.0\.0\.1|localhost|w3\.org' }
```

### 3.2 动态验证（运行时抓包）

启动应用后，用任意抓包工具（Wireshark / Fiddler / `netstat`）观察 `dounai.exe` 及
其 WebView2 子进程的连接：

```powershell
# 只看 ESTABLISHED 的外部连接（排除回环）
Get-NetTCPConnection -State Established |
  Where-Object { $_.RemoteAddress -notmatch '^(127\.0\.0\.1|::1|0\.0\.0\.0)$' } |
  Select-Object LocalPort, RemoteAddress, RemotePort,
    @{n='Process';e={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}}
```

**预期结果**：没有任何属于 `dounai` / `msedgewebview2` 的外部连接。

### 3.3 断网验证（最直观）

拔掉网络（或开飞行模式），启动悬浮窗：

- 界面正常显示、不崩溃；
- 若三个上游在**本机**运行，对话、语音**全部正常**；
- 这就是"纯本地"的直接证据。

---

## 4. 唯一的外部流量来自哪里

本层不发起外部请求，但**你可能会观察到外部流量**，来源是上游模块：

| 模块 | 何时出网 | 谁负责 |
|---|---|---|
| 输入接入层 | 使用云端 ASR（如 Qwen3-ASR）时上传音频 | `Dounai_input` 的隐私文档 |
| LLM 编排核心 | 调用云端 LLM 厂商时发送对话文本 | `OmniNexus` 的隐私文档 |
| 输出表达层 | 使用 `edge` / `openai` / `azure` 等在线 TTS 时发送文本 | `MoodVoice` 的 `docs/PRIVACY.md` |

**如果你要彻底离线**：

- 输入层：用本地 faster-whisper（`dounai-input models install`）
- 模型层：用本地 Ollama / LM Studio / vLLM
- 语音层：用 `local` TTS 适配器（指向你自建的 GPT-SoVITS / CosyVoice）

三者都选本地方案后，整个产品**零外部流量**。

---

## 5. 未来变化约定

若本层将来需要新增任何外部域名（例如检查更新），必须：

1. 在此文件的白名单表格里列明**具体域名**；
2. 同步修改 CSP 与代理白名单；
3. 在 Release Notes 中说明，并在首次启动时明确告知用户；
4. 提供关闭开关（默认开启需用户同意）。

**在此之前，白名单为空集是本层的承诺。**

---

## 6. 相关文档

- [跨域与代理](cors-and-proxy.md) —— 为什么必须经主进程转发
- [安全策略](../SECURITY.md) —— 漏洞披露与响应时限
- [隐私承诺](../README.md#-隐私承诺) —— 面向用户的数据处理声明
