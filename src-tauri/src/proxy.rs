//! 上游代理。
//!
//! 为什么需要它：三个上游模块都不为浏览器跨域开口子（见 docs/cors-and-proxy.md）：
//!  - input 无 CORS 头；
//!  - OmniNexus 默认 cors_origins 为空；
//!  - output 对未白名单的 Origin 直接 403。
//!
//! 因此所有上游请求都在主进程发出（无浏览器 Origin 语义），渲染层只与本进程通信。
//!
//! 隐私：这里**不**记录请求体或响应体，只记录状态码与耗时。

use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

/// 单次请求的超时上限；具体阶段超时由前端传入。
const MAX_TIMEOUT_MS: u64 = 180_000;

#[derive(Debug, Deserialize)]
pub struct ProxyRequest {
    /// 完整 URL，必须是 http(s) 且指向本机回环地址
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub body: Option<String>,
    /// 二进制请求体（base64）。用于图像/语音的 multipart 上传。
    ///
    /// 为什么走 base64：前端与主进程之间是 JSON IPC，无法直接传字节。
    /// 解码后原样转发，Content-Type 由前端给出的 multipart 边界头决定。
    #[serde(default)]
    pub body_base64: Option<String>,
    /// 额外请求头（键值对）
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// 超时（毫秒），缺省 30s
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Serialize)]
pub struct ProxyError {
    pub kind: String,
    pub message: String,
}

/// 只允许回环地址：防止被滥用成任意 SSRF 跳板。
fn is_loopback_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    match parsed.host_str() {
        Some(host) => {
            host == "127.0.0.1"
                || host == "localhost"
                || host == "::1"
                || host == "[::1]"
                || host == "0.0.0.0"
        }
        None => false,
    }
}

/// 前端调用的统一入口。
#[tauri::command]
pub async fn upstream_request<R: Runtime>(
    _app: AppHandle<R>,
    request: ProxyRequest,
) -> Result<ProxyResponse, ProxyError> {
    if !is_loopback_url(&request.url) {
        return Err(ProxyError {
            kind: "forbidden".into(),
            message: "只允许访问本机回环地址".into(),
        });
    }

    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(30_000).min(MAX_TIMEOUT_MS));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| ProxyError {
            kind: "client".into(),
            message: e.to_string(),
        })?;

    let method = request.method.to_uppercase();
    let mut builder = match method.as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        other => {
            return Err(ProxyError {
                kind: "method".into(),
                message: format!("不支持的方法 {other}"),
            })
        }
    };

    for (key, value) in &request.headers {
        builder = builder.header(key, value);
    }
    if let Some(encoded) = &request.body_base64 {
        // 图像/语音上传：解码为原始字节再转发
        let bytes = BASE64_STANDARD.decode(encoded).map_err(|error| ProxyError {
            kind: "encode".into(),
            message: format!("二进制请求体解码失败：{error}"),
        })?;
        builder = builder.body(bytes);
    } else if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }

    let started = Instant::now();
    let response = match builder.send().await {
        Ok(resp) => resp,
        Err(error) => {
            let kind = if error.is_timeout() {
                "timeout"
            } else if error.is_connect() {
                "unavailable"
            } else {
                "request"
            };
            return Err(ProxyError {
                kind: kind.into(),
                message: error.to_string(),
            });
        }
    };

    let status = response.status().as_u16();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let body = match response.text().await {
        Ok(text) => text,
        Err(error) => {
            return Err(ProxyError {
                kind: "body".into(),
                message: error.to_string(),
            })
        }
    };

    Ok(ProxyResponse {
        status,
        body,
        headers,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// 流式代理单块数据。
///
/// 用枚举而不是裸 String：前端需要区分"数据块"与"结束/错误"，
/// 否则无法判断流是否正常收尾（SSE 连接可能被静默切断）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamChunk {
    /// 响应头（首个事件，status + headers 只发一次）
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    /// 数据块（原始字节以 UTF-8 文本呈现，SSE 本身是文本协议）
    Data { text: String },
    /// 正常结束
    Done { elapsed_ms: u128 },
    /// 出错（发生在流中途，而非建连阶段）
    Error { kind: String, message: String },
}

/// 流式上游请求：边收边推，前端可逐块消费。
///
/// 与 `upstream_request` 的区别：
/// - 非流式版本等全部收完再返回（适用于探活/CRUD）
/// - 本函数用 `bytes_stream()` 逐块推送（适用于 SSE 对话）
///
/// 安全约束与 `upstream_request` 完全一致：只允许回环地址。
#[tauri::command]
pub async fn upstream_request_stream<R: Runtime>(
    _app: AppHandle<R>,
    request: ProxyRequest,
    on_event: tauri::ipc::Channel<StreamChunk>,
) -> Result<(), ProxyError> {
    if !is_loopback_url(&request.url) {
        return Err(ProxyError {
            kind: "forbidden".into(),
            message: "只允许访问本机回环地址".into(),
        });
    }

    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(60_000).min(MAX_TIMEOUT_MS));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| ProxyError {
            kind: "client".into(),
            message: e.to_string(),
        })?;

    let method = request.method.to_uppercase();
    let mut builder = match method.as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        other => {
            return Err(ProxyError {
                kind: "method".into(),
                message: format!("不支持的方法 {other}"),
            })
        }
    };

    for (key, value) in &request.headers {
        builder = builder.header(key, value);
    }
    if let Some(encoded) = &request.body_base64 {
        let bytes = BASE64_STANDARD.decode(encoded).map_err(|error| ProxyError {
            kind: "encode".into(),
            message: format!("二进制请求体解码失败：{error}"),
        })?;
        builder = builder.body(bytes);
    } else if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }

    let started = Instant::now();
    let response = match builder.send().await {
        Ok(resp) => resp,
        Err(error) => {
            let kind = if error.is_timeout() {
                "timeout"
            } else if error.is_connect() {
                "unavailable"
            } else {
                "request"
            };
            // 建连失败也要通过 channel 告知，让前端统一处理
            let _ = on_event.send(StreamChunk::Error {
                kind: kind.to_string(),
                message: error.to_string(),
            });
            return Ok(());
        }
    };

    let status = response.status().as_u16();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    // 先发响应头，前端据此判断是否需要继续
    let _ = on_event.send(StreamChunk::Head { status, headers });

    // 逐块读取并推送。SSE 是 UTF-8 文本协议，但 TCP 分块可能切断多字节字符，
    // 因此用跨块保留的缓冲区拼接，只在遇到完整行时才下发（见下方中文处理）。
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    // 累积未成行的半截字节，避免 UTF-8 被切成两半
    let mut pending: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                pending.extend_from_slice(&bytes);
                // 只在换行处切分，保证每个 Data 块是完整行
                while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = pending.drain(..=pos).collect();
                    let text = String::from_utf8_lossy(&line).to_string();
                    if on_event.send(StreamChunk::Data { text }).is_err() {
                        // 前端已取消订阅：提前结束，不再消耗流量
                        return Ok(());
                    }
                }
            }
            Err(error) => {
                let _ = on_event.send(StreamChunk::Error {
                    kind: "stream".to_string(),
                    message: error.to_string(),
                });
                return Ok(());
            }
        }
    }

    // 尾部残留（最后一行可能没有换行）
    if !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending).to_string();
        let _ = on_event.send(StreamChunk::Data { text });
    }

    let _ = on_event.send(StreamChunk::Done {
        elapsed_ms: started.elapsed().as_millis(),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback() {
        assert!(is_loopback_url("http://127.0.0.1:8101/healthz"));
        assert!(is_loopback_url("http://localhost:8102/v1/healthz"));
        assert!(is_loopback_url("http://[::1]:8103/api/health"));
    }

    #[test]
    fn rejects_remote_and_non_http() {
        assert!(!is_loopback_url("http://example.com/api"));
        assert!(!is_loopback_url("http://192.168.1.10:8000/"));
        assert!(!is_loopback_url("file:///C:/secret"));
        assert!(!is_loopback_url("ftp://127.0.0.1/"));
        assert!(!is_loopback_url("not a url"));
    }
}
