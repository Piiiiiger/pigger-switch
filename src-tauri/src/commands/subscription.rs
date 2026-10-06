use tauri::{Emitter, State};

use crate::error::AppError;
use crate::services::subscription::SubscriptionQuota;
use crate::store::AppState;

/// 查询官方订阅额度（Claude / Codex）
///
/// 读取 CLI 工具已有的 OAuth 凭据并调用官方 API 获取使用额度。
/// `Ok`（成功或确定性失败）写入 `UsageCache`、通知托盘刷新并 emit
/// `usage-cache-updated`，前端和托盘共享同一份最新数据。
/// `Err`（瞬时传输失败）不写快照、不 emit：保留上一份数据。
#[tauri::command]
pub async fn get_subscription_quota(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    tool: String,
) -> Result<SubscriptionQuota, String> {
    let quota = crate::services::subscription::get_subscription_quota(&tool).await?;
    crate::services::alerts::record_quota(&app, &state, &tool, &quota);
    Ok(quota)
}

/// 每个额度窗口的实际额度估算（本机用量 ÷ 接口给的百分比）和过去的窗口
#[tauri::command]
pub async fn get_quota_windows(
    state: State<'_, AppState>,
    tool: String,
) -> Result<crate::services::quota_windows::QuotaWindowsReport, AppError> {
    let quota = state.usage_cache.with_subscription(&tool, Clone::clone);
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::quota_windows::build_report(
            &db,
            &tool,
            quota.as_ref(),
            chrono::Utc::now().timestamp(),
        )
    })
    .await
    .map_err(|e| AppError::Message(format!("估算额度失败: {e}")))?
}

/// 把额度快照放进缓存、通知前端和托盘（命令和后台刷新共用）
pub(crate) fn publish_quota(
    app: &tauri::AppHandle,
    state: &AppState,
    tool: &str,
    quota: &SubscriptionQuota,
) {
    let payload = serde_json::json!({ "tool": tool, "data": quota });
    if let Err(e) = app.emit("subscription-quota-updated", payload) {
        log::error!("emit subscription-quota-updated 失败: {e}");
    }
    state.usage_cache.put_subscription(tool, quota.clone());
    crate::tray::schedule_tray_refresh(app);
}
