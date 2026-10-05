//! 全局 HTTP 客户端
//!
//! 订阅额度查询共用一个客户端。设置里填了网络代理就走它，否则跟随系统代理
//! （reqwest 默认读取 HTTP(S)_PROXY / ALL_PROXY 环境变量）。

use reqwest::Client;
use std::sync::RwLock;
use std::time::Duration;

static GLOBAL_CLIENT: RwLock<Option<Client>> = RwLock::new(None);

/// 按代理设置重建全局客户端；`None` 或空字符串表示不额外指定代理。
pub fn apply_proxy(proxy_url: Option<&str>) -> Result<(), String> {
    let client = build_client(proxy_url)?;
    let mut slot = GLOBAL_CLIENT
        .write()
        .map_err(|_| "Failed to update HTTP client: lock poisoned".to_string())?;
    *slot = Some(client);
    Ok(())
}

/// 只校验代理地址，不应用。
pub fn validate_proxy(proxy_url: Option<&str>) -> Result<(), String> {
    build_client(proxy_url).map(|_| ())
}

/// 获取全局 HTTP 客户端（还没初始化时按无代理构建一个）
pub fn get() -> Client {
    if let Some(client) = GLOBAL_CLIENT.read().ok().and_then(|slot| slot.clone()) {
        return client;
    }
    build_client(None).unwrap_or_default()
}

fn build_client(proxy_url: Option<&str>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("pigger-switch/", env!("CARGO_PKG_VERSION")));

    if let Some(url) = proxy_url.map(str::trim).filter(|s| !s.is_empty()) {
        let parsed = url::Url::parse(url).map_err(|e| format!("Invalid proxy URL: {e}"))?;
        if !["http", "https", "socks5", "socks5h"].contains(&parsed.scheme()) {
            return Err(format!(
                "Invalid proxy scheme '{}'. Supported: http, https, socks5, socks5h",
                parsed.scheme()
            ));
        }
        let proxy = reqwest::Proxy::all(url).map_err(|e| format!("Invalid proxy URL: {e}"))?;
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_proxy_accepts_supported_schemes_only() {
        assert!(validate_proxy(None).is_ok());
        assert!(validate_proxy(Some("  ")).is_ok());
        assert!(validate_proxy(Some("http://127.0.0.1:7890")).is_ok());
        assert!(validate_proxy(Some("socks5://127.0.0.1:1080")).is_ok());
        assert!(validate_proxy(Some("ftp://127.0.0.1:21")).is_err());
        assert!(validate_proxy(Some("not a url")).is_err());
    }
}
