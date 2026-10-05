//! 数据库模块 - SQLite 数据持久化
//!
//! ```text
//! database/
//! ├── mod.rs     - Database 结构体 + 初始化
//! ├── schema.rs  - 表结构定义 + 默认模型定价
//! ├── backup.rs  - 破坏性操作前的安全备份
//! ├── import.rs  - 从 CC Switch 数据库导入历史用量
//! └── dao/       - 数据访问对象（设置、日聚合）
//! ```

pub(crate) mod backup;
mod dao;
pub(crate) mod import;
mod schema;

use crate::config::get_app_config_dir;
use crate::error::AppError;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

/// 当前 Schema 版本号
/// 每次修改表结构时递增，并在 schema.rs 的 `apply_schema_migrations_on_conn` 里追加迁移
pub(crate) const SCHEMA_VERSION: i32 = 1;

/// 明细保留天数：更早的明细汇总进 `usage_daily_rollups` 后删除
pub(crate) const DETAIL_RETAIN_DAYS: i64 = 30;

/// 安全地获取 Mutex 锁，避免 unwrap panic
macro_rules! lock_conn {
    ($mutex:expr) => {
        $mutex
            .lock()
            .map_err(|e| AppError::Database(format!("Mutex lock failed: {}", e)))?
    };
}

// 导出宏供子模块使用
pub(crate) use lock_conn;

/// 数据库文件路径：`<数据目录>/pigger-switch.db`
pub(crate) fn db_path() -> PathBuf {
    get_app_config_dir().join("pigger-switch.db")
}

/// 数据库连接封装
///
/// 使用 Mutex 包装 Connection 以支持在多线程环境（如 Tauri State）中共享。
/// rusqlite::Connection 本身不是 Sync 的，因此需要这层包装。
pub struct Database {
    pub(crate) conn: Mutex<Connection>,
    /// 请求日志总数缓存，见 `services::usage_stats::LogCountCache`
    pub(crate) log_count_cache: Mutex<Option<crate::services::usage_stats::LogCountCache>>,
}

impl Database {
    /// 初始化数据库连接并创建表
    pub fn init() -> Result<Self, AppError> {
        let db_path = db_path();
        let db_exists = db_path.exists();

        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
        }

        let conn = Connection::open(&db_path).map_err(|e| AppError::Database(e.to_string()))?;
        if !db_exists {
            // 新库在建表前设好增量 auto-vacuum，剪枝后的空间可以就地回收
            conn.execute("PRAGMA auto_vacuum = INCREMENTAL;", [])
                .map_err(|e| AppError::Database(e.to_string()))?;
        }
        // 后台同步和前端查询会并发访问；WAL 让读不被写阻塞
        let _ = conn.pragma_update(None, "journal_mode", "WAL");

        let db = Self {
            conn: Mutex::new(conn),
            log_count_cache: Mutex::new(None),
        };
        db.create_tables()?;
        db.apply_schema_migrations()?;
        db.ensure_model_pricing_seeded()?;
        if let Err(e) = crate::services::model_pricing::sync_local_model_pricing(&db) {
            log::warn!("Failed to sync local model pricing file: {e}");
        }

        if let Err(e) = db.rollup_and_prune(DETAIL_RETAIN_DAYS) {
            log::warn!("Startup rollup_and_prune failed: {e}");
        }
        {
            let conn = lock_conn!(db.conn);
            if let Err(e) = Self::incremental_vacuum_on_conn(&conn) {
                log::warn!("Startup incremental vacuum failed: {e}");
            }
        }

        Ok(db)
    }

    /// 创建内存数据库（用于测试）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn memory() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory().map_err(|e| AppError::Database(e.to_string()))?;
        conn.execute("PRAGMA auto_vacuum = INCREMENTAL;", [])
            .map_err(|e| AppError::Database(e.to_string()))?;

        let db = Self {
            conn: Mutex::new(conn),
            log_count_cache: Mutex::new(None),
        };
        db.create_tables()?;
        db.ensure_model_pricing_seeded()?;

        Ok(db)
    }

    /// 回收全部空闲页。`PRAGMA incremental_vacuum` 每释放一页产出一行结果，
    /// 必须把结果读完才会回收完；`execute_batch` 只 step 一次，只能回收 1 页。
    pub(crate) fn incremental_vacuum_on_conn(conn: &Connection) -> Result<(), AppError> {
        let mut stmt = conn
            .prepare("PRAGMA incremental_vacuum;")
            .map_err(|e| AppError::Database(format!("执行 incremental_vacuum 失败: {e}")))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| AppError::Database(format!("执行 incremental_vacuum 失败: {e}")))?;
        while rows
            .next()
            .map_err(|e| AppError::Database(format!("执行 incremental_vacuum 失败: {e}")))?
            .is_some()
        {}
        Ok(())
    }
}
