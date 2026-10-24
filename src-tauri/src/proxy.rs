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
    /// 额外请求头（键值对）
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// 超时（毫秒），缺省 30s
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// 是否按 SSE 流式读取（返回逐行事件）
    #[serde(default)]
    pub stream: bool,
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
    if let Some(body) = &request.body {
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
