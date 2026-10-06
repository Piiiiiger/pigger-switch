use serde::Serialize;

use crate::error::AppError;
use crate::services::pigger_sync::{self, SyncOutcome, SyncStatus};

/// 同步到 Pigger 的状态（设置页展示）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiggerSyncInfo {
    #[serde(flatten)]
    pub status: SyncStatus,
    /// 没填电脑名时用的名字（主机名）
    pub default_device_name: String,
}

#[tauri::command]
pub fn get_pigger_sync_status() -> PiggerSyncInfo {
    PiggerSyncInfo {
        status: pigger_sync::status(),
        default_device_name: pigger_sync::default_device_name(),
    }
}

/// 立即把全部用量推一遍
#[tauri::command]
pub async fn sync_pigger_now(app: tauri::AppHandle) -> Result<SyncOutcome, AppError> {
    crate::run_pigger_sync(&app, true).await
}
