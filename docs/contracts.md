# Dounai 组装层 · 上游事件契约

> 本文件是组装层与三个上游模块之间的**唯一**接口依据。
> 所有字段名、语义、边界均以各模块自身文档为准；本层只消费，不解释、不改写。

## 0. 拓扑与端口

| 模块 | 仓库 | 默认端口 | 组装层使用 | 探活 |
|---|---|---|---|---|
| 输入接入层 | `Dounai_input` | 8000 | `127.0.0.1:8101` | `GET /healthz` |
| 模型编排核心 | `OmniNexus` | 8000 | `127.0.0.1:8102` | `GET /v1/healthz` |
| 情感语音输出层 | `MoodVoice` | 8765 | `127.0.0.1:8103` | `GET /api/health` |

> **端口冲突提示**：`input` 与 `OmniNexus` 默认都是 `8000`，同机部署必须错开。
> 本层默认配置为 8101/8102/8103，用户可在设置中覆盖。

## 1. 输入事件（`input` 产出）

`POST /v1/inputs/text` → `201`，响应体即契约事件：

```json
{
  "event_id": "7e2c664e-420d-4993-91ae-5fac73a9c584",
  "timestamp": "2026-10-24T09:38:37.008Z",
  "modality": "text",
  "content": "今天有点累，想找人说说话。",
  "metadata": {
    "asr_text": "",
    "voiceprint_event": "none",
    "model_capabilities": ["text", "image", "audio"]
  }
}
```

| 字段 | 约束 | 组装层用途 |
|---|---|---|
| `event_id` | UUID | 作为下游幂等键 |
| `modality` | `text`/`image`/`audio` | 决定 UI 图标与是否显示转写文本 |
| `content` | 文本或媒体 URL | 媒体 URL 需带 `input` 基址才能加载 |
| `metadata.voiceprint_event` | `wakeup`/`none` | **唤醒态唯一触发源** |
| `metadata.asr_text` | 字符串 | 语音输入的转写结果，显示为「你（语音）」 |

### 1.1 三路输入的请求形态

三个入口最终产出**同一种**事件，因此下游只需处理一种形状：

| 输入 | 请求 | 组装层调用 |
|---|---|---|
| 文字 | `POST /v1/inputs/text`（JSON `{text, session_id?, source}`） | `InputAdapter.submitText` |
| 图像 | `POST /v1/inputs/image`（multipart：`file` + `session_id`? + `source`?） | `InputAdapter.submitImage` |
| 语音 | `POST /v1/inputs/audio`（multipart：`file` + `language`? + …） | `InputAdapter.submitAudio` |

约束（均由上游执行，组装层不重复实现）：

- 图像：JPEG / PNG / WebP / GIF，≤ 15MB，按**魔数**校验（伪造扩展名会被拒）；
- 语音：WAV / MP3 / M4A / FLAC / OGG / WebM，≤ 25MB；
- `language` 为 BCP-47 形式（`zh`、`en-US`），非法值返回 422。

组装层只做两件事：构造 multipart 报文；把响应按契约解析。

### 1.2 降级信号

`input` 的降级信息**不进事件体**（保证契约稳定），只放在响应头：

- `X-Dounai-Degraded: true`
- `X-Dounai-Provider` / `X-Dounai-Model`
- `X-Dounai-Voiceprint-Checked: true/false`

组装层必须读这些头，否则「语音没转写成功」会被静默忽略。

## 2. LLM 输出事件（`OmniNexus` 产出，SSE）

`POST /v1/events`，`Accept: text/event-stream`。

帧序列：

```text
meta → route → delta* → citations? → final
```

失败序列：

```text
meta → error                                    （首 token 前全失败）
meta → route → delta* → warning → final          （已输出部分后中断）
```

### 2.1 契约事件

`delta` 帧（`stream: true`，增量）：

```json
{
  "event_id": "…",
  "session_id": "…",
  "content": "增量文本",
  "stream": true,
  "tags": {"emotion": "neutral", "type": "text", "intent": "reply"}
}
```

`final` 帧（`stream: false`，**完整替换值**）：

```json
{
  "event_id": "…",
  "session_id": "…",
  "content": "完整文本",
  "stream": false,
  "tags": {"emotion": "comfort", "type": "text", "intent": "reply"}
}
```

| 字段 | 语义 | 组装层用途 |
|---|---|---|
| `event_id` | 同一回合所有帧一致 | 归并键 |
| `content` | delta 为增量；final 为完整文本 | **UI 只以 final 为准做最终渲染**，delta 用于即时上屏 |
| `tags.emotion` | joy/sadness/anger/fear/surprise/confusion/frustration/gratitude/neutral | 情感态预留 + 传给 `output` |
| `tags.type` | text/code/list/table/json/mixed | 渲染方式（代码块不朗读） |
| `tags.intent` | reply/tool/linkage | `output` 据此决定是否合成语音 |

**关键约束**：delta 的 tags 是「当前已累积文本」的临时值，可能变化；
下游必须使用 `final` 的 tags。组装层遵守此约定，避免情感标签抖动导致表情乱跳。

### 2.2 提示词：供 UI 调用的接口

结构图把提示词操作标注为「预留更换接口供 UI 调用」。组装层用**每轮覆盖**语义实现，
不维护会话生命周期：

| 请求 | 用途 |
|---|---|
| `GET /v1/prompts/profiles` | 列出配置，供界面下拉选择 |
| 请求体 `metadata.prompt_profile` | **本轮**使用的配置 ID |

选这个方式而不是 `POST /v1/sessions/{id}/prompt` 的理由：后者要求组装层先建会话、
再维护 `session_id` 的生命周期，会让「换个提示词」这种轻量操作牵动状态管理。
每轮覆盖的语义更小、也更容易做失败降级——拿不到配置列表时静默用默认配置，对话不受影响。

### 2.3 辅助帧

| 帧 | 用途 |
|---|---|
| `meta` | 会话、计划模型、检索/记忆状态、能力降级 |
| `route` | 实际厂商/模型、是否回退（用于「已降级」徽标） |
| `citations` | 搜索结果，可展示来源 |
| `warning` | 部分输出后中断，随后仍有 final |
| `error` | 未产生文本即失败，无 final |

### 2.4 错误体

```json
{"error": {"code": "ALL_PROVIDERS_FAILED", "message": "…", "retryable": false,
           "details": {"attempts": [...]}, "request_id": "…"}}
```

组装层按 `code` 映射为用户可读文案，**不显示** `details` 原文（可能含内部信息）。

## 3. 音频渲染事件（`output` 产出）

`POST /api/v1/outputs` → `200`，请求体为 `InputEvent` 形状：

```json
{
  "event_id": "uuid",
  "session_id": "uuid",
  "content": "完整文本",
  "stream": false,
  "tags": {"emotion": "comfort", "type": "text", "intent": "reply"}
}
```

响应体 `OutputEvent`：

```json
{
  "event_id": "…",
  "text": "原文，逐字保持",
  "audio_ref": "/api/v1/audio/<hash>.mp3",
  "style": {"emotion": "comfort", "label": "安慰", "speed": 0.92, "tone": "…"},
  "speech_text": "实际朗读稿",
  "render": {"type": "text", "mode": "plain", "blocks": []},
  "route": {"intent": "reply", "destination": "ui.voice_reply", "synthesize": true},
  "status": "synthesized",
  "degraded": false,
  "timings": {"first_chunk_ms": 836.7, "total_ms": 1163.1}
}
```

| 字段 | 约束 | 组装层用途 |
|---|---|---|
| `audio_ref` | **相对 URL**，或 `null` | 必须拼接 `output` 基址才能播放 |
| `audio_mime` | 如 `audio/mpeg` | 播放前校验 |
| `status` | `synthesized`/`text_only`/`text_fallback` | `text_fallback` 表示无语音，只显示文本 |
| `degraded` | bool | 降级徽标 |
| `route.synthesize` | bool | `false` 时不期待音频 |
| `render.blocks` | 渲染建议 | 代码块用等宽字体，不朗读 |

### 3.1 `audio_ref` 生命周期

`audio_ref` **不是永久链接**：缓存会过期或被清理（默认 200 文件 / 168 小时）。
组装层不得持久化它作为历史消息的播放地址，只能当场播放。

### 3.2 合成失败

`status=text_fallback` 且 `degraded=true`，`audio_ref=null`。
此时 UI 必须**照常显示文本**，仅标记语音不可用——这是最常见的降级路径。

## 4. 组装层的编排规则

```text
用户输入
  └─► input: POST /v1/inputs/{text|image|audio}
        └─► 得到 InputEvent（含 event_id / modality / voiceprint_event）
              └─► OmniNexus: POST /v1/events (SSE)
                    ├─ delta*  ──► UI 流式追加（按帧合并，不重排）
                    └─ final   ──► 用 final.content + final.tags
                          └─► output: POST /api/v1/outputs
                                └─► OutputEvent
                                      ├─ text        ──► 替换为最终文本
                                      ├─ audio_ref   ──► 拼基址后播放
                                      └─ status      ──► 决定是否显示「语音不可用」
```

### 4.1 为什么用 `final` 而不是 delta 调 `output`

`output` 的文档明确要求接收「聚合后的完整文本」，并写明「如果未来上游改成 token 流，
应在接入层先聚合」。逐 delta 合成会导致：多次 TTS 调用、句间断裂、音色跳变、
以及最典型的**音画不同步**。组装层就是那个负责聚合的接入层。

### 4.2 幂等

- `input` 的 `event_id` 作为 OmniNexus 的幂等键，重投返回同一 `output event_id`；
- 组装层对同一 `event_id` 的 `final` 只处理一次（SSE 重连时可能重放）；
- 新回合必须使用新 `event_id`。

### 4.3 超时预算

| 阶段 | 超时 | 超时表现 |
|---|---|---|
| `input` 请求 | 15s（图片/语音 60s） | 提示「输入处理超时」，回到 default |
| OmniNexus 首 token | 45s（与上游 `first_token_timeout_s` 对齐） | 提示「模型响应超时」，可重试 |
| OmniNexus 整体 | 120s | 中断并保留已显示文本 |
| `output` 合成 | 90s | 文本照常，标记语音不可用 |

## 5. 组装层不消费但需容忍的字段

上游会随版本增加字段。本层的解析器必须：

- 忽略未知字段（前向兼容）；
- 对缺失的可选字段提供默认值；
- 对**必填字段缺失**报错并降级，而不是崩溃。

对应实现见 `src/contracts/*.ts` 的解析函数与 `tests/contracts` 的契约测试。
