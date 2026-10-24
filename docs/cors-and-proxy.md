# 上游连通性与跨域（CORS）说明

> 本文记录一个**真实存在、必须由组装层处理**的集成问题，以及最终采用的方案。
> 这不是理论推演，是在本机实测中踩到的。

## 1. 现象

组装层在**浏览器上下文**（WebView 或 dev server）里直接 `fetch` 三个上游，会出现：

| 上游 | 端口 | 实测结果 |
|---|---|---|
| `input` | 8101 | 响应**无** `Access-Control-Allow-Origin` |
| `OmniNexus` | 8102 | 默认 `cors_origins: []` → 不挂 CORS 中间件，无 ACAO |
| `output` | 8103 | 带 `Origin` 头直接返回 **403 `origin_not_allowed`** |

实测命令与结果：

```text
GET /v1/healthz  Origin: http://127.0.0.1:4173  → 200, acao=None
GET /healthz     Origin: http://127.0.0.1:4173  → 200, acao=None
GET /api/health  Origin: http://127.0.0.1:4173  → 403 Forbidden
```

在浏览器里，上述任意一种都会让请求在**网络层**失败，表现为
`TypeError: Failed to fetch`——UI 只能显示「服务未连接」，但服务其实是活的。
这是最容易误判为「上游挂了」的陷阱。

## 2. 三个上游各自的策略（均不允许前端直连）

- **input**：明确不为浏览器跨域开口子，注释里写明「浏览器表单可以写 localhost，
  不需要 CORS 许可」——它假设调用方是**非浏览器**进程。
- **OmniNexus**：CORS 白名单来自配置 `server.cors_origins`，默认为空；
  文档也写明「本地服务，无内建认证」，默认只监听 `127.0.0.1`。
- **output**：有显式的 Origin 白名单校验，未在 `EMOTION_TTS_ALLOWED_ORIGINS` 中的
  Origin 一律 403，这是它防 CSRF 的设计。

**结论**：三个模块的安全模型都假设「调用方是本地非浏览器进程」。
让 WebView 直连是错误做法，既绕不过 CORS，也会破坏它们各自的防护。

## 3. 采用的方案：主进程代理（Rust 侧转发）

组装层把所有上游请求放在 **Tauri 主进程**（Rust）里发出，渲染层只与本进程通信。

```text
Renderer (WebView)
   │  invoke("upstream_request", {...})      ← 同源，无 CORS
   ▼
Main (Rust)  ──reqwest/tauri-plugin-http──►  input / OmniNexus / output
   │  HTTP，无浏览器 Origin 语义，不会被 403
   ▼
返回结构化结果给渲染层
```

优点：

1. **彻底绕开 CORS**：主进程的请求没有浏览器 Origin 约束；
2. **不削弱上游安全**：不需要给 output 加白名单、不需要给 OmniNexus 开 `cors_origins`；
3. **密钥不进入渲染层**：未来若需要带 token，token 只存在主进程；
4. **可统一超时与重试**：超时策略集中在一处，便于做降级与埋点。

代价：

1. 需要把 `fetch` 调用换成 `invoke`，适配器多一层；
2. SSE 需要主进程转发（Rust 侧读取流再 `emit` 给前端，或由前端轮询缓冲区）。

## 4. 开发模式下的替代方案

`npm run dev` 时没有 Tauri 主进程，因此用 **Vite 代理**等价实现：

```ts
// vite.config.ts
server: {
  proxy: {
    "/api/input":  { target: "http://127.0.0.1:8101", rewrite: p => p.replace(/^\/api\/input/, "") },
    "/api/llm":    { target: "http://127.0.0.1:8102", rewrite: p => p.replace(/^\/api\/llm/, "") },
    "/api/output": { target: "http://127.0.0.1:8103", rewrite: p => p.replace(/^\/api\/output/, "") },
  },
}
```

代理请求由 Node 发出，同样没有浏览器 Origin 语义，因此 output 的 403 不会触发。
这让**同一份前端代码**在 dev 与 Tauri 下都能工作，只需切换 base URL。

## 5. 对用户的影响（写进用户文档）

- 用户**不需要**修改任何上游配置，也不需要给上游加 CORS 白名单；
- 如果用户自行把上游部署到**另一台机器**，需要：
  - 在组装层设置里改成对应地址；
  - 自行评估网络暴露风险（上游无认证，官方文档明确要求不要暴露公网）。
- 如果用户在浏览器里直接打开 `http://127.0.0.1:8103` 调试，仍会看到 403——
  那是 output 的正常防护，不是故障。

## 6. 验收对应关系

| 需求条目 | 本方案的落实 |
|---|---|
| 通过约定的事件契约对接 | 契约解析在 `src/contracts/`，与传输方式解耦 |
| 某模块不可用时优雅降级 | 代理层把「连接失败 / 超时 / 403 / 契约错误」分类，UI 分别提示 |
| 隐私：数据不外传 | 代理只连 `127.0.0.1`，不做任何外发 |
| 不记录对话内容 | 代理层日志只记状态码、耗时、event_id |
