# 全链路集成测试 · 环境准备

集成测试用**真实上游**验证契约，不 mock。未启动时会自动跳过，不阻塞常规单测。

> **前提**：本仓库是组装层，本身不包含三个上游的源码。
> 你需要另外把 `Dounai_input`、`OmniNexus`、`MoodVoice` 三个仓库克隆到**任意位置**
> （下面用 `$INPUT_REPO` / `$LLM_REPO` / `$TTS_REPO` 表示它们的路径）。

## 1. 端口约定

| 模块 | 变量 | 默认 | 探活 |
|---|---|---|---|
| 输入层 | `DOUNAI_INPUT_URL` | `http://127.0.0.1:8101` | `/healthz` |
| 模型层 | `DOUNAI_LLM_URL` | `http://127.0.0.1:8102` | `/v1/healthz` |
| 语音层 | `DOUNAI_OUTPUT_URL` | `http://127.0.0.1:8103` | `/api/health` |

## 2. 启动三个上游

先把三个仓库的路径填进来（按你的实际位置改）：

```powershell
$INPUT_REPO = "C:\src\Dounai_input"
$LLM_REPO   = "C:\src\OmniNexus"
$TTS_REPO   = "C:\src\output"
$DATA       = "$env:TEMP\dounai-it"    # 上游数据目录，放临时区即可
New-Item -ItemType Directory -Force -Path $DATA | Out-Null
```

### 2.1 输入层（8101）

```powershell
$env:DOUNAI_DATA_DIR = "$DATA\input-data"
$env:DOUNAI_PORT = "8101"
cd $INPUT_REPO
.\.venv\Scripts\python.exe -m dounai_input serve
```

### 2.2 模型层（8102，启用离线 echo 模型）

`echo` 默认关闭。复制一份配置并把它打开，避免污染上游仓库：

```powershell
# 把 $LLM_REPO\config\default.yaml 里 echo 段的 enabled: false 改成 true，
# 存到 $DATA\omni-config.yaml
New-Item -ItemType Directory -Force -Path "$DATA\omni" | Out-Null
(Get-Content "$LLM_REPO\config\default.yaml" -Raw) `
  -replace '(?m)(\s+echo:\r?\n\s+type: echo[\s\S]{0,200}?enabled: )false', '${1}true' `
  | Set-Content "$DATA\omni\config.yaml" -Encoding UTF8

$env:OMNI_CONFIG = "$DATA\omni\config.yaml"
$env:OMNI_DATA_DIR = "$DATA\omni-data"
$env:OMNI_PORT = "8102"
cd $LLM_REPO
.\.venv\Scripts\python.exe -m omninexus
```

验证：

```powershell
curl http://127.0.0.1:8102/v1/models | Select-String 'echo:echo'
# 应看到 "available":true
```

### 2.3 语音层（8103）

```powershell
$env:EMOTION_TTS_DATA_DIR = "$DATA\tts-data"
$env:EMOTION_TTS_PORT = "8103"
$env:EMOTION_TTS_ROOT = $TTS_REPO
$env:PYTHONPATH = "$TTS_REPO\src"
cd $TTS_REPO
python -m emotional_tts serve
```

> 语音层依赖 `edge-tts`。若提示 `No module named edge_tts`：
> `python -m pip install "edge-tts>=7,<8"`。
>
> edge TTS 需要外网。离线环境下语音层会走 `text_fallback`（只出文本），
> 这本身也是一种合法状态，降级测试专门覆盖它。

## 3. 运行测试

```powershell
cd <本仓库路径>
npm test
```

若某个上游未就绪，测试会打印：

```text
[integration] 上游未全部就绪 input=true llm=false output=true，相关用例将跳过
```

也可以用环境变量指向别的主机/端口：

```powershell
$env:DOUNAI_INPUT_URL  = "http://127.0.0.1:9101"
$env:DOUNAI_LLM_URL    = "http://127.0.0.1:9102"
$env:DOUNAI_OUTPUT_URL = "http://127.0.0.1:9103"
npm test
```

## 4. 为什么用 echo 模型

`echo:echo` 是 OmniNexus 自带的**离线诊断模型**，不调用任何外部厂商、不需要密钥、
输出确定。它让「链路与契约正确性」可以在无网络、无密钥的环境下被稳定验证。

注意：它输出的是固定模板文本，**不是**真实 LLM 回答。因此集成测试验证的是
「事件能否正确流转」，不验证「回答质量」。
