use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::settings::AppSettings;
use crate::store::AppState;

#[tauri::command]
pub fn get_settings() -> AppSettings {
    crate::settings::get_settings()
}

/// 保存设置；开机自启、网络代理、托盘显示这类即时生效的项在这里应用
#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    settings: AppSettings,
) -> Result<AppSettings, AppError> {
    let previous = crate::settings::get_settings();
    crate::services::http_client::validate_proxy(settings.network_proxy_url.as_deref())
        .map_err(AppError::InvalidInput)?;

    let saved = crate::settings::update_settings(settings)?;

    if saved.launch_on_startup != previous.launch_on_startup {
        let result = if saved.launch_on_startup {
            crate::auto_launch::enable_auto_launch()
        } else {
            crate::auto_launch::disable_auto_launch()
        };
        if let Err(e) = result {
            log::warn!("更新开机自启失败: {e}");
        }
    }
    if saved.network_proxy_url != previous.network_proxy_url {
        if let Err(e) =
            crate::services::http_client::apply_proxy(saved.network_proxy_url.as_deref())
        {
            log::warn!("应用网络代理失败: {e}");
        }
    }
    if saved.show_in_tray != previous.show_in_tray || saved.language != previous.language {
        crate::tray::schedule_tray_refresh(&app);
    }
    Ok(saved)
}

/// 应用和数据来源的路径信息（设置页「数据」一节展示）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub claude_dir: String,
    pub claude_dir_exists: bool,
    pub codex_dir: String,
    pub codex_dir_exists: bool,
    pub cc_switch_db: String,
    pub cc_switch_db_exists: bool,
    pub cc_switch_imported_at: Option<i64>,
}

#[tauri::command]
pub fn get_app_info(state: State<'_, AppState>) -> Result<AppInfo, AppError> {
    let claude_dir = crate::config::get_claude_config_dir();
    let codex_dir = crate::config::get_codex_config_dir();
    let cc_switch_db = crate::config::get_cc_switch_db_path();
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: crate::config::get_app_config_dir().display().to_string(),
        claude_dir_exists: claude_dir.join("projects").is_dir(),
        claude_dir: claude_dir.display().to_string(),
        codex_dir_exists: codex_dir.join("sessions").is_dir(),
        codex_dir: codex_dir.display().to_string(),
        cc_switch_db_exists: cc_switch_db.is_file(),
        cc_switch_db: cc_switch_db.display().to_string(),
        cc_switch_imported_at: state.db.cc_switch_imported_at()?,
    })
}

/// 从 CC Switch 的数据库导入历史用量；`path` 为空时用默认位置 `~/.cc-switch/cc-switch.db`
#[tauri::command]
pub async fn import_cc_switch_history(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<crate::database::import::ImportResult, AppError> {
    let source = path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(crate::settings::resolve_override_path)
        .unwrap_or_else(crate::config::get_cc_switch_db_path);
    let db = state.db.clone();
    // 和后台同步互斥：导入期间不让会话日志插进来
    let _guard = crate::services::session_usage::session_sync_mutex()
        .lock()
        .await;
    tauri::async_runtime::spawn_blocking(move || {
        let result = db.import_cc_switch_history(&source)?;
        if let Err(e) = db.rollup_and_prune(crate::database::DETAIL_RETAIN_DAYS) {
            log::warn!("导入后归档旧明细失败: {e}");
        }
        Ok(result)
    })
    .await
    .map_err(|e| AppError::Message(format!("导入任务失败: {e}")))?
}

/// 把前端生成的文本（CSV 导出）写到用户在保存对话框里选的位置
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), AppError> {
    let path = std::path::PathBuf::from(path);
    std::fs::write(&path, content).map_err(|e| AppError::io(&path, e))
}

/// 在文件管理器里打开应用数据目录
#[tauri::command]
pub fn open_data_dir(app: tauri::AppHandle) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::config::get_app_config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| AppError::io(&dir, e))?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<String>)
        .map_err(|e| AppError::Message(format!("打开目录失败: {e}")))
}

/// 让原生窗口（标题栏等）跟着界面主题走；"system" 表示跟随系统
#[tauri::command]
pub fn set_window_theme(window: tauri::Window, theme: String) -> Result<(), AppError> {
    let theme = match theme.as_str() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    };
    window
        .set_theme(theme)
        .map_err(|e| AppError::Message(format!("设置窗口主题失败: {e}")))
}
