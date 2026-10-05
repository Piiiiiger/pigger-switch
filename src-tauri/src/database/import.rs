//! 从 CC Switch 的数据库导入 Claude Code / Codex 的历史用量。
//!
//! CC Switch 只保留最近 30 天的明细，更早的汇总在按天表里；客户端自己的会话日志
//! 通常也只留 30 天。导入它的数据库能把更早的历史找回来，也能带上经它本地路由
//! 记账、会话日志里没有的请求。
//!
//! 规则：
//! - 明细按 `request_id` 去重（会话日志导入的行两边 ID 相同），重复的跳过。
//! - 按天汇总：某天某应用在本库已有会话日志来的数据时跳过那一天，避免同一批
//!   请求在两边各算一次；只缺的那些天才导入。
//! - 去重账本一并导入，以后同步会话日志时认得出已经算过的请求。

use super::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

/// 只导入这两个应用（`claude-desktop` 是 CC Switch 记的 Claude Desktop 网关流量，展示时并入 Claude）
const IMPORTED_APP_TYPES: &str = "'claude', 'claude-desktop', 'codex'";

/// 设置表里记录上次导入时间的键
pub(crate) const IMPORTED_AT_KEY: &str = "cc_switch_imported_at";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub detail_rows: u64,
    pub detail_skipped: u64,
    pub rollup_rows: u64,
    pub rollup_days_skipped: u64,
    pub dedup_rows: u64,
}

impl Database {
    /// 从 `source` 指向的 CC Switch 数据库导入历史用量。
    pub fn import_cc_switch_history(&self, source: &Path) -> Result<ImportResult, AppError> {
        if !source.exists() {
            return Err(AppError::InvalidInput(format!(
                "找不到 CC Switch 数据库: {}",
                source.display()
            )));
        }
        // 只读打开，确认是 CC Switch 的库再动本库
        {
            let src = Connection::open_with_flags(
                source,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|e| AppError::Database(format!("打开 CC Switch 数据库失败: {e}")))?;
            if !Self::table_exists(&src, "proxy_request_logs")? {
                return Err(AppError::InvalidInput(
                    "这不是 CC Switch 的数据库（没有 proxy_request_logs 表）".to_string(),
                ));
            }
        }

        // 导入会改很多行，先留一份备份
        if let Err(e) = self.backup_database_file() {
            log::warn!("导入前备份失败，继续导入: {e}");
        }

        let conn = lock_conn!(self.conn);
        conn.execute(
            "ATTACH DATABASE ?1 AS ccs",
            [source.to_string_lossy().as_ref()],
        )
        .map_err(|e| AppError::Database(format!("挂载 CC Switch 数据库失败: {e}")))?;
        let result = Self::import_attached(&conn);
        let detach = conn.execute("DETACH DATABASE ccs", []);
        let result = result?;
        detach.map_err(|e| AppError::Database(format!("卸载 CC Switch 数据库失败: {e}")))?;

        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![IMPORTED_AT_KEY, chrono::Utc::now().timestamp().to_string()],
        )?;
        drop(conn);

        crate::usage_events::notify_log_recorded();
        Ok(result)
    }

    fn import_attached(conn: &Connection) -> Result<ImportResult, AppError> {
        let mut result = ImportResult::default();
        conn.execute("SAVEPOINT cc_switch_import", [])?;
        let outcome = (|| -> Result<(), AppError> {
            result.detail_rows = Self::import_detail_rows(conn, &mut result)?;
            result.rollup_rows = Self::import_rollups(conn, &mut result)?;
            result.dedup_rows = Self::import_dedup_ledger(conn)?;
            Ok(())
        })();
        match outcome {
            Ok(()) => {
                conn.execute("RELEASE cc_switch_import", [])?;
                Ok(result)
            }
            Err(e) => {
                conn.execute("ROLLBACK TO cc_switch_import", []).ok();
                conn.execute("RELEASE cc_switch_import", []).ok();
                Err(e)
            }
        }
    }

    /// 两边都有的列（老版本 CC Switch 少几列，缺的列用本库默认值）
    fn shared_columns(conn: &Connection, table: &str) -> Result<Vec<String>, AppError> {
        let read = |schema: &str| -> Result<HashSet<String>, AppError> {
            let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info(\"{table}\")"))?;
            let names = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<HashSet<_>, _>>()?;
            Ok(names)
        };
        let ours = read("main")?;
        let theirs = read("ccs")?;
        let mut shared: Vec<String> = ours.intersection(&theirs).cloned().collect();
        shared.sort();
        Ok(shared)
    }

    fn import_detail_rows(conn: &Connection, result: &mut ImportResult) -> Result<u64, AppError> {
        let columns = Self::shared_columns(conn, "proxy_request_logs")?;
        if !columns.iter().any(|c| c == "request_id") {
            return Ok(0);
        }
        let column_list = columns
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let candidates: u64 = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM ccs.proxy_request_logs WHERE app_type IN ({IMPORTED_APP_TYPES})"
            ),
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let inserted = conn.execute(
            &format!(
                "INSERT OR IGNORE INTO main.proxy_request_logs ({column_list})
                 SELECT {column_list} FROM ccs.proxy_request_logs
                 WHERE app_type IN ({IMPORTED_APP_TYPES})"
            ),
            [],
        )? as u64;
        result.detail_skipped = candidates.saturating_sub(inserted);
        Ok(inserted)
    }

    fn import_rollups(conn: &Connection, result: &mut ImportResult) -> Result<u64, AppError> {
        if !Self::attached_table_exists(conn, "usage_daily_rollups")? {
            return Ok(0);
        }
        let columns = Self::shared_columns(conn, "usage_daily_rollups")?;
        if !["date", "app_type"]
            .iter()
            .all(|c| columns.iter().any(|x| x == c))
        {
            return Ok(0);
        }

        // 本库已有数据的 (日期, 应用)：本库的会话日志明细和按天汇总
        let folded = "CASE WHEN app_type = 'claude-desktop' THEN 'claude' ELSE app_type END";
        let covered_sql = format!(
            "SELECT DISTINCT date(created_at, 'unixepoch', 'localtime') AS day, {folded} AS app
             FROM main.proxy_request_logs WHERE data_source <> 'proxy'
             UNION
             SELECT DISTINCT date, {folded} FROM main.usage_daily_rollups"
        );
        conn.execute("DROP TABLE IF EXISTS temp.import_covered_days", [])?;
        conn.execute(
            &format!("CREATE TEMP TABLE import_covered_days AS {covered_sql}"),
            [],
        )?;

        let skipped_days: u64 = conn.query_row(
            &format!(
                "SELECT COUNT(DISTINCT r.date || '|' || {folded_r})
                 FROM ccs.usage_daily_rollups r
                 WHERE r.app_type IN ({IMPORTED_APP_TYPES})
                   AND EXISTS (SELECT 1 FROM temp.import_covered_days c
                               WHERE c.day = r.date AND c.app = {folded_r})",
                folded_r =
                    "CASE WHEN r.app_type = 'claude-desktop' THEN 'claude' ELSE r.app_type END"
            ),
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;
        result.rollup_days_skipped = skipped_days;

        let column_list = columns
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let select_list = columns
            .iter()
            .map(|c| format!("r.\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let inserted = conn.execute(
            &format!(
                "INSERT OR IGNORE INTO main.usage_daily_rollups ({column_list})
                 SELECT {select_list} FROM ccs.usage_daily_rollups r
                 WHERE r.app_type IN ({IMPORTED_APP_TYPES})
                   AND NOT EXISTS (
                       SELECT 1 FROM temp.import_covered_days c
                       WHERE c.day = r.date
                         AND c.app =
                             CASE WHEN r.app_type = 'claude-desktop' THEN 'claude' ELSE r.app_type END
                   )"
            ),
            [],
        )? as u64;
        conn.execute("DROP TABLE IF EXISTS temp.import_covered_days", [])?;
        Ok(inserted)
    }

    fn import_dedup_ledger(conn: &Connection) -> Result<u64, AppError> {
        if !Self::attached_table_exists(conn, "session_usage_dedup")? {
            return Ok(0);
        }
        Ok(conn.execute(
            "INSERT OR IGNORE INTO main.session_usage_dedup
                 (data_source, request_id, semantic_id, has_entry_id)
             SELECT data_source, request_id, semantic_id, has_entry_id
             FROM ccs.session_usage_dedup
             WHERE data_source IN ('session_log', 'codex_session')",
            [],
        )? as u64)
    }

    fn attached_table_exists(conn: &Connection, table: &str) -> Result<bool, AppError> {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM ccs.sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get::<_, i64>(0),
        )? > 0)
    }

    /// 上次从 CC Switch 导入的时间（秒）
    pub fn cc_switch_imported_at(&self) -> Result<Option<i64>, AppError> {
        Ok(self
            .get_setting(IMPORTED_AT_KEY)?
            .and_then(|v| v.parse::<i64>().ok()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_db(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("cc-switch.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE proxy_request_logs (
                request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL,
                model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0, total_cost_usd TEXT NOT NULL DEFAULT '0',
                latency_ms INTEGER NOT NULL, status_code INTEGER NOT NULL,
                created_at INTEGER NOT NULL, data_source TEXT NOT NULL DEFAULT 'proxy');
             CREATE TABLE usage_daily_rollups (
                date TEXT NOT NULL, app_type TEXT NOT NULL, provider_id TEXT NOT NULL,
                model TEXT NOT NULL, request_model TEXT NOT NULL DEFAULT '',
                pricing_model TEXT NOT NULL DEFAULT '', request_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0, total_cost_usd TEXT NOT NULL DEFAULT '0',
                PRIMARY KEY (date, app_type, provider_id, model, request_model, pricing_model));
             INSERT INTO proxy_request_logs VALUES
                ('session:a', '_session', 'claude', 'claude-opus', 10, 5, '0.5', 0, 200, 1790000000, 'session_log'),
                ('proxy:b', 'p1', 'codex', 'gpt-5', 20, 8, '0.2', 100, 200, 1790000100, 'proxy'),
                ('proxy:c', 'p1', 'gemini', 'gemini-pro', 1, 1, '0.1', 100, 200, 1790000200, 'proxy');
             INSERT INTO usage_daily_rollups (date, app_type, provider_id, model, request_count,
                success_count, input_tokens, output_tokens, total_cost_usd) VALUES
                ('2026-01-01', 'claude', '_session', 'claude-opus', 3, 3, 30, 15, '1.5'),
                ('2026-01-02', 'claude', '_session', 'claude-opus', 2, 2, 20, 10, '1.0'),
                ('2026-01-02', 'gemini', '_gemini_session', 'gemini-pro', 9, 9, 9, 9, '9');",
        )
        .unwrap();
        path
    }

    #[test]
    fn imports_claude_and_codex_and_skips_days_we_already_have() {
        let dir = tempfile::tempdir().unwrap();
        let source = source_db(dir.path());
        let db = Database::memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            // 本库已有 2026-01-02 的 Claude 汇总：CC Switch 那天的汇总要跳过
            conn.execute(
                "INSERT INTO usage_daily_rollups (date, app_type, provider_id, model, request_count)
                 VALUES ('2026-01-02', 'claude', '_session', 'claude-opus', 2)",
                [],
            )
            .unwrap();
            // 同一条会话请求本库已经有了
            conn.execute(
                "INSERT INTO proxy_request_logs (request_id, provider_id, app_type, model,
                    latency_ms, status_code, created_at, data_source)
                 VALUES ('session:a', '_session', 'claude', 'claude-opus', 0, 200, 1790000000, 'session_log')",
                [],
            )
            .unwrap();
        }

        let result = db.import_cc_switch_history(&source).unwrap();
        assert_eq!(result.detail_rows, 1, "only the proxy codex row is new");
        assert_eq!(result.detail_skipped, 1);
        assert_eq!(result.rollup_rows, 1, "only 2026-01-01 is imported");
        assert_eq!(result.rollup_days_skipped, 1);

        let conn = db.conn.lock().unwrap();
        let gemini: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE app_type = 'gemini'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gemini, 0);
        let project: String = conn
            .query_row(
                "SELECT project FROM proxy_request_logs WHERE request_id = 'proxy:b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(project, "");
        drop(conn);
        assert!(db.cc_switch_imported_at().unwrap().is_some());
    }

    #[test]
    fn rejects_files_that_are_not_cc_switch_databases() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("other.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE something (id INTEGER)")
            .unwrap();
        let db = Database::memory().unwrap();
        assert!(db.import_cc_switch_history(&path).is_err());
        assert!(db
            .import_cc_switch_history(&dir.path().join("missing.db"))
            .is_err());
    }
}
