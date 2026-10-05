//! 应用设置：存放在 `<数据目录>/settings.json`，进程内缓存一份。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use crate::error::AppError;

fn default_true() -> bool {
    true
}

/// 应用设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// 显示系统托盘图标（托盘里有今日用量和额度摘要）
    #[serde(default = "default_true")]
    pub show_in_tray: bool,
    /// 关闭窗口时最小化到托盘而不是退出
    #[serde(default = "default_true")]
    pub minimize_to_tray_on_close: bool,
    /// 开机自启
    #[serde(default)]
    pub launch_on_startup: bool,
    /// 静默启动（启动时不显示主窗口，仅托盘运行）
    #[serde(default)]
    pub silent_startup: bool,
    /// 界面语言（zh / zh-TW / en / ja），未设置时跟随系统
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// 用量面板自动刷新间隔（毫秒，0 为关闭）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_dashboard_refresh_interval_ms: Option<u32>,
    /// 会话日志自动扫描（默认开启）。关闭后只在点击「立即同步」时扫描。
    #[serde(default = "default_true")]
    pub session_auto_sync_enabled: bool,
    /// 自定义 Claude Code 配置目录（默认 `~/.claude`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_config_dir: Option<String>,
    /// 自定义 Codex 配置目录（默认 `~/.codex`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_config_dir: Option<String>,
    /// 查询订阅额度时使用的网络代理（如 `http://127.0.0.1:7890`），为空时跟随系统代理
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_proxy_url: Option<String>,
    /// 每日花费预算（美元，按 API 价格折算）；超过时托盘和面板提醒
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_budget_usd: Option<f64>,
    /// 每月花费预算（美元，按 API 价格折算）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monthly_budget_usd: Option<f64>,
    /// 订阅额度用到这个百分比时发桌面通知（0 或空为关闭）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_alert_percent: Option<u8>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            show_in_tray: true,
            minimize_to_tray_on_close: true,
            launch_on_startup: false,
            silent_startup: false,
            language: None,
            usage_dashboard_refresh_interval_ms: None,
            session_auto_sync_enabled: true,
            claude_config_dir: None,
            codex_config_dir: None,
            network_proxy_url: None,
            daily_budget_usd: None,
            monthly_budget_usd: None,
            quota_alert_percent: None,
        }
    }
}

impl AppSettings {
    fn settings_path() -> PathBuf {
        crate::config::get_app_config_dir().join("settings.json")
    }

    fn normalize(&mut self) {
        let trim = |value: &mut Option<String>| {
            *value = value
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        };
        trim(&mut self.claude_config_dir);
        trim(&mut self.codex_config_dir);
        trim(&mut self.network_proxy_url);
        trim(&mut self.language);
        if !matches!(
            self.language.as_deref(),
            None | Some("zh" | "zh-TW" | "en" | "ja")
        ) {
            self.language = None;
        }
        let positive = |value: Option<f64>| value.filter(|v| v.is_finite() && *v > 0.0);
        self.daily_budget_usd = positive(self.daily_budget_usd);
        self.monthly_budget_usd = positive(self.monthly_budget_usd);
        self.quota_alert_percent = self.quota_alert_percent.filter(|p| (1..=100).contains(p));
    }

    fn load_from_file() -> Self {
        let path = Self::settings_path();
        let Ok(content) = fs::read_to_string(&path) else {
            return Self::default();
        };
        match serde_json::from_str::<AppSettings>(&content) {
            Ok(mut settings) => {
                settings.normalize();
                settings
            }
            Err(e) => {
                log::warn!("解析设置文件失败，使用默认设置: {}: {e}", path.display());
                Self::default()
            }
        }
    }
}

fn save_settings_file(settings: &AppSettings) -> Result<(), AppError> {
    let path = AppSettings::settings_path();
    let mut json = serde_json::to_vec_pretty(settings)
        .map_err(|e| AppError::Config(format!("序列化设置失败: {e}")))?;
    json.push(b'\n');
    crate::config::atomic_write(&path, &json)
}

static SETTINGS_STORE: OnceLock<RwLock<AppSettings>> = OnceLock::new();

fn settings_store() -> &'static RwLock<AppSettings> {
    SETTINGS_STORE.get_or_init(|| RwLock::new(AppSettings::load_from_file()))
}

/// 把 `~`、`~/…` 展开成用户目录下的路径
pub(crate) fn resolve_override_path(raw: &str) -> PathBuf {
    let home = crate::config::get_home_dir;
    let join_home = |suffix: &str| {
        suffix
            .split(['/', '\\'])
            .filter(|component| !component.is_empty())
            .fold(home(), |path, component| path.join(component))
    };

    if raw == "~" {
        return home();
    }
    if let Some(stripped) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return join_home(stripped);
    }
    PathBuf::from(raw)
}

pub fn get_settings() -> AppSettings {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .clone()
}

/// 保存设置并更新缓存，返回规范化后的设置
pub fn update_settings(mut new_settings: AppSettings) -> Result<AppSettings, AppError> {
    new_settings.normalize();
    save_settings_file(&new_settings)?;
    let mut guard = settings_store().write().unwrap_or_else(|e| e.into_inner());
    *guard = new_settings.clone();
    Ok(new_settings)
}

pub fn get_claude_override_dir() -> Option<PathBuf> {
    get_settings()
        .claude_config_dir
        .as_deref()
        .map(resolve_override_path)
}

pub fn get_codex_override_dir() -> Option<PathBuf> {
    get_settings()
        .codex_config_dir
        .as_deref()
        .map(resolve_override_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_paths_and_drops_invalid_values() {
        let mut settings = AppSettings {
            claude_config_dir: Some("  ".to_string()),
            codex_config_dir: Some(" ~/.codex-work ".to_string()),
            language: Some("fr".to_string()),
            daily_budget_usd: Some(-1.0),
            monthly_budget_usd: Some(200.0),
            quota_alert_percent: Some(0),
            ..AppSettings::default()
        };
        settings.normalize();
        assert_eq!(settings.claude_config_dir, None);
        assert_eq!(settings.codex_config_dir.as_deref(), Some("~/.codex-work"));
        assert_eq!(settings.language, None);
        assert_eq!(settings.daily_budget_usd, None);
        assert_eq!(settings.monthly_budget_usd, Some(200.0));
        assert_eq!(settings.quota_alert_percent, None);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let settings: AppSettings = serde_json::from_str("{}").expect("parse");
        assert!(settings.show_in_tray);
        assert!(settings.session_auto_sync_enabled);
        assert!(!settings.launch_on_startup);
    }
}
