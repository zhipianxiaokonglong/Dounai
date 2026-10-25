# 如何设置模型

> Dounai 的悬浮窗本身不调用任何大模型 —— 模型由**模型层（OmniNexus）**负责。
> 所以你不需要在悬浮窗里填任何密钥，只要把模型层配置好，悬浮窗就会自动用上。
>
> 本文按「最快能聊上天」的顺序写，从零开始。

---

## 0. 一句话原理

```text
悬浮窗（本仓库）  ──HTTP──►  模型层 :8102  ──密钥──►  厂商 API
                                    ▲
                              密钥只放在这里
```

- 密钥**只存在于模型层的环境变量**里，悬浮窗从不读取、不保存、不上传；
- 悬浮窗只连 `127.0.0.1:8102`，它不知道你用了哪家厂商。

---

## 1. 最快路径：用离线模型先跑通（不需要任何密钥）

只想先看看界面能不能聊、语音能不能响，用模型层自带的离线诊断模型 `echo`。

**第 1 步：启用 echo**

`echo` 默认是关闭的。找到模型层的 `config/default.yaml`，把这个段落的 `enabled: false` 改成 `true`：

```yaml
providers:
  echo:
    type: echo
    label: Offline diagnostic model
    requires_key: false
    enabled: true      # ← 改成 true
```

> 不想改仓库文件的话，复制一份配置再改，用 `OMNI_CONFIG` 指向副本即可（推荐）。

**第 2 步：启动模型层**

```powershell
cd <模型层仓库路径>
$env:OMNI_PORT = "8102"
python -m omninexus
```

**第 3 步：确认 echo 可用**

```powershell
curl http://127.0.0.1:8102/v1/models
```

在返回的 JSON 里找 `"id": "echo:echo"`，旁边的 `"available"` 应该是 `true`。

**第 4 步：在悬浮窗里选它**

打开悬浮窗 → 点右上角展开面板 → 现在可以直接发消息。
如果你在设置里指定了模型，把它填成 `echo:echo`。

> ⚠️ echo 输出的是**固定模板文本**（会复述你说的话），不是真实回答。
> 它的用途是验证链路是否通，不是日常聊天。

---

## 2. 接入真实厂商（BYOK）

### 2.1 选一家厂商

模型层内置 16 家云端厂商 + 4 种本地方案。常见的几家：

| 厂商 | 模型示例 | 密钥环境变量 |
|---|---|---|
| OpenAI | `gpt-4o-mini`、`gpt-4o` | `OPENAI_API_KEY` |
| Anthropic | `claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` |
| DeepSeek | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| 阿里通义千问 | `qwen-plus`、`qwen-max` | `DASHSCOPE_API_KEY` |
| 月之暗面 Kimi | `kimi-latest` | `MOONSHOT_API_KEY` |
| 智谱 GLM | `glm-4-plus` | `ZHIPU_API_KEY` |
| 字节豆包（火山方舟） | `doubao-1-5-pro-32k-250115` | `ARK_API_KEY` |
| Google Gemini | `gemini-2.5-flash` | `GEMINI_API_KEY` |
| OpenRouter（聚合） | `openrouter/auto` | `OPENROUTER_API_KEY` |

完整清单（含 Base URL、协议）见模型层的 `docs/providers.md`。

### 2.2 拿到密钥

到对应厂商的控制台创建 API Key，复制备用。例如：

- OpenAI：<https://platform.openai.com/api-keys>
- DeepSeek：<https://platform.deepseek.com/api_keys>
- 智谱：<https://open.bigmodel.cn/usercenter/apikeys>

### 2.3 告诉模型层密钥（两种方式，任选其一）

**方式 A：`.env` 文件（推荐，适合本地长期使用）**

在**模型层仓库根目录**建一个 `.env` 文件（该文件已被 `.gitignore` 忽略，不会进版本库）：

```powershell
cd <模型层仓库路径>
Copy-Item .env.example .env
notepad .env
```

填入你那一家的密钥，例如只用 DeepSeek：

```ini
DEEPSEEK_API_KEY=sk-你的密钥
```

**方式 B：当前终端的环境变量（适合临时试）**

```powershell
$env:DEEPSEEK_API_KEY = "sk-你的密钥"
python -m omninexus
```

> ⚠️ **`.env` 是从「当前工作目录」加载的**，不是从仓库根目录自动找。
> 所以必须先 `cd` 到模型层仓库根目录再启动，否则密钥读不到，
> 表现就是「模型列表里 available 全是 false」。

### 2.4 重启模型层

密钥是启动时读取的，改完要重启进程：

```powershell
# Ctrl+C 停掉之前的，然后
cd <模型层仓库路径>
$env:OMNI_PORT = "8102"
python -m omninexus
```

### 2.5 验证已生效

```powershell
curl http://127.0.0.1:8102/v1/providers
```

找到你配的那家，`available` 应为 `true`。
再看模型列表：

```powershell
curl http://127.0.0.1:8102/v1/models
```

对应模型（如 `deepseek:deepseek-chat`）的 `"available"` 变成 `true` 就成功了。

> `available=true` 只表示**密钥已配置**，不保证网络可达。
> 真连不上时模型层会自动回退到下一个候选，并在响应里标注 `fallback`。

---

## 3. 让悬浮窗用上你配的模型

### 3.1 默认行为：自动

悬浮窗不指定模型时，模型层会用自己配置里的 `default_model`（默认 `openai:gpt-4o-mini`）。
如果你只配了 DeepSeek，而这个默认值是 OpenAI，就会出现「没有任何可用模型」的报错。

**建议**：把模型层的 `default_model` 改成你实际有的那家。在 `config/default.yaml`：

```yaml
gateway:
  default_model: deepseek:deepseek-chat
```

### 3.2 指定模型（可选）

也可以在悬浮窗设置里固定一个模型 ID。格式是 `厂商:模型`：

```text
deepseek:deepseek-chat
openai:gpt-4o-mini
dashscope:qwen-plus
```

填错厂商或模型名会得到 `UNKNOWN_MODEL`，悬浮窗会提示「上游服务返回了错误」。

---

## 4. 用本地模型（完全离线、免费）

想彻底不联网、不花钱，用 Ollama 之类的本地服务：

**第 1 步：装 Ollama 并拉一个模型**

```powershell
ollama pull llama3.2
ollama serve
```

**第 2 步：在模型层启用 ollama provider**

`config/default.yaml` 里把 `providers.ollama.enabled` 改成 `true`：

```yaml
providers:
  ollama:
    type: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    requires_key: false
    enabled: true      # ← 改成 true
```

**第 3 步：重启模型层并验证**

```powershell
curl http://127.0.0.1:8102/v1/models   # ollama:llama3.2 应为 available
```

同理支持 LM Studio（`127.0.0.1:1234`）、vLLM（`:8000`）、llama.cpp（`:8080`）。

> 本地模型不产生任何外发流量，隐私上是最强的一档；代价是回答质量取决于你的硬件和模型大小。

---

## 5. 语音模型怎么配（可选）

语音合成由**语音层（MoodVoice）**负责，和聊天模型是两套配置。

| 方案 | 需要密钥 | 说明 |
|---|---|---|
| `edge`（默认） | 不需要 | 微软 Edge 在线朗读，开箱即用，但文本会离开本机 |
| `openai` | `OPENAI_API_KEY` | 音质好，可传情感指令 |
| `azure` | `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` | 情感风格最丰富 |
| `elevenlabs` | `ELEVENLABS_API_KEY` | 表现力强 |
| `minimax` | `MINIMAX_API_KEY` | 中文自然 |
| `local` | 不需要 | 指向你自己部署的 GPT-SoVITS / CosyVoice，**完全不出本机** |

配置方式同在语音层仓库根目录写 `.env`，然后重启语音层。

**不想配也能用**：语音层没配任何厂商时会走 `text_fallback` ——
悬浮窗照常显示文字，只是没有声音，并会标注「语音暂不可用」。

> 隐私敏感就选 `local`；图省事就用默认的 `edge`。

---

## 6. 常见问题

### 6.1 悬浮窗提示「还没有可用的模型」

模型层没有任何 `available=true` 的模型。按顺序查：

1. 密钥写进 `.env` 了吗？
2. **启动时有没有 `cd` 到模型层仓库根目录**？（最常见的原因）
3. 改完密钥**重启**模型层了吗？
4. `curl http://127.0.0.1:8102/v1/providers` 里那一家的 `available` 是 true 吗？

### 6.2 提示「模型厂商鉴权失败」

`PROVIDER_AUTH` —— 密钥无效、过期，或者复制时带了空格/换行。重新生成一个再试。

### 6.3 提示「模型厂商限流了」

`PROVIDER_RATE_LIMITED` —— 触发厂商的频率限制。等一会，或在模型层调低 `gateway.rate_limit_rpm`。

### 6.4 有文字但没有声音

这是**语音层**的问题，不是模型问题。检查 `curl http://127.0.0.1:8103/api/health`，
看 `providers` 里有没有 `ready: true` 的那一项。

### 6.5 想换模型但不想丢上下文

在模型层里切模型是**会话级**操作，切换后上下文会保留。
悬浮窗这边改动模型设置会影响**新的一轮**，当前这轮不受影响。

### 6.6 密钥会不会被上传？

不会。密钥只在模型层进程内读取，用于直连厂商 API。
它不写数据库、不写日志、不进 HTTP 响应，悬浮窗更是完全接触不到。

---

## 7. 配置检查清单

启动前扫一眼，能省掉大部分问题：

- [ ] 模型层已启动，`curl http://127.0.0.1:8102/v1/healthz` 返回 `{"status":"ok"}`
- [ ] 至少一个模型的 `available` 是 `true`
- [ ] 模型层的 `default_model` 指向你实际配置的那家
- [ ] 语音层已启动（想听声音的话），`curl http://127.0.0.1:8103/api/health` 正常
- [ ] 输入层已启动，端口不是和模型层撞车的 `8000`
