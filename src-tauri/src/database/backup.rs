//! 数据库安全备份
//!
//! 只在破坏性操作（重建 Codex 用量、导入历史）前调用：用 SQLite 在线备份 API
//! 写一份一致性快照到 `<数据目录>/backups/`，保留最近 [`BACKUP_RETAIN_COUNT`] 份。

use super::{lock_conn, Database};
use crate::error::AppError;
use chrono::Local;
use rusqlite::backup::Backup;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const BACKUP_RETAIN_COUNT: usize = 5;

impl Database {
    /// 生成一致性快照备份，返回备份文件路径（内存库没有文件，返回 None）
    pub(crate) fn backup_database_file(&self) -> Result<Option<PathBuf>, AppError> {
        let db_path = {
            let conn = lock_conn!(self.conn);
            match conn.path().filter(|p| !p.is_empty()) {
                Some(path) => PathBuf::from(path),
                None => return Ok(None),
            }
        };
        let backup_dir = db_path
            .parent()
            .ok_or_else(|| AppError::Config("无效的数据库路径".to_string()))?
            .join("backups");
        fs::create_dir_all(&backup_dir).map_err(|e| AppError::io(&backup_dir, e))?;

        let stamp = Local::now().format("%Y%m%d_%H%M%S");
        let mut backup_path = backup_dir.join(format!("db_backup_{stamp}.db"));
        let mut suffix = 1;
        while backup_path.exists() {
            backup_path = backup_dir.join(format!("db_backup_{stamp}_{suffix}.db"));
            suffix += 1;
        }
        // 先写到临时名，完整写完再改名，备份目录里不会出现半截文件
        let temp_path = backup_dir.join(format!(".db_backup_{stamp}.tmp"));

        {
            let conn = lock_conn!(self.conn);
            let mut dest =
                Connection::open(&temp_path).map_err(|e| AppError::Database(e.to_string()))?;
            let backup =
                Backup::new(&conn, &mut dest).map_err(|e| AppError::Database(e.to_string()))?;
            backup
                .run_to_completion(256, Duration::from_millis(0), None)
                .map_err(|e| AppError::Database(format!("创建数据库安全备份失败: {e}")))?;
        }
        fs::rename(&temp_path, &backup_path).map_err(|e| AppError::io(&backup_path, e))?;
        cleanup_old_backups(&backup_dir);
        log::info!("已创建数据库备份: {}", backup_path.display());
        Ok(Some(backup_path))
    }
}

fn cleanup_old_backups(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut backups: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("db_backup_") && n.ends_with(".db"))
        })
        .collect();
    // 文件名里的时间戳按字典序即按时间排序
    backups.sort();
    let excess = backups.len().saturating_sub(BACKUP_RETAIN_COUNT);
    for path in backups.into_iter().take(excess) {
        if let Err(e) = fs::remove_file(&path) {
            log::warn!("删除旧备份 {} 失败: {e}", path.display());
        }
    }
}
