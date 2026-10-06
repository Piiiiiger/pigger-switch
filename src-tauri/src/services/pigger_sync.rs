//! 把用量推送到 Pigger 面板（「AI 用量」页）。
//!
//! 只推不拉：按天汇总（应用、项目、模型），连同会话和订阅额度，用一个只能上传
//! 用量的 API 令牌 POST 到 `{面板地址}/panel/api/aiUsage/ingest`。一份报告覆盖
//! from..to 的整天，面板拿它替换这些天的旧数据，所以重发和窗口重叠都不会重复计数。

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::{Local, NaiveDate, TimeZone};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::database::{lock_conn, Database, DETAIL_RETAIN_DAYS};
use crate::error::AppError;
use crate::services::quota_windows::QuotaWindowsReport;
use crate::services::sql_helpers::fresh_input_sql;
use crate::services::subscription::{CredentialStatus, SubscriptionQuota};
use crate::services::usage_stats::{
    effective_model_sql, effective_usage_log_filter_for_range, folded_app_type_sql,
};
use crate::services::UsageCache;

/// 应用开着时多久推一次
pub const SYNC_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// 全量重发的间隔：改了价格、导入了历史，旧日子的数字会变
const FULL_SYNC_EVERY_SECS: i64 = 24 * 60 * 60;
/// 平时只推最近这几天（今天和昨天）
const RECENT_DAYS: i64 = 2;
/// 全量同步时每份报告最多覆盖这么多天，免得一个请求太大
const DAYS_PER_REPORT: i64 = 60;
/// 一份报告最多带这么多会话（面板的上限）
const MAX_SESSIONS: u32 = 5000;
/// 设备 ID 存在数据库的设置表里：改电脑名字，面板上还是同一台
const DEVICE_KEY_SETTING: &str = "pigger_device_key";
/// 面板只认 Claude Code 和 Codex；Claude 桌面版的记录算进 Claude
const SYNCED_APPS_SQL: &str = "'claude', 'claude-desktop', 'codex'";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDevice {
    pub key: String,
    pub name: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReportDay {
    pub day: String,
    pub app: String,
    pub project: String,
    pub model: String,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSession {
    pub app: String,
    pub session_id: String,
    pub title: String,
    pub project: String,
    pub model: String,
    pub requests: i64,
    pub tokens: i64,
    pub cache_read_tokens: i64,
    pub cost_usd: f64,
    pub first_at: i64,
    pub last_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportTier {
    pub name: String,
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportQuota {
    pub tool: String,
    pub success: bool,
    pub plan_label: String,
    pub active_until: String,
    pub tiers: Vec<ReportTier>,
    pub error: String,
    /// 毫秒
    pub queried_at: i64,
    /// 这个工具每个窗口的估算和过去的窗口；读数失败时没有
    pub estimates: Option<QuotaWindowsReport>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub device: ReportDevice,
    pub from: String,
    pub to: String,
    pub daily: Vec<ReportDay>,
    pub sessions: Vec<ReportSession>,
    /// 非 0 时，这份报告代表这台电脑自此（Unix 秒）以来活动过的全部会话：
    /// 面板删掉其中报告里没有的。0 只增改。
    pub sessions_since: i64,
    pub quotas: Vec<ReportQuota>,
}

/// 同步状态（设置页展示）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub running: bool,
    pub last_attempt_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub last_full_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_rows: u32,
    pub last_sessions: u32,
}

static STATUS: Mutex<SyncStatus> = Mutex::new(SyncStatus {
    running: false,
    last_attempt_at: None,
    last_success_at: None,
    last_full_at: None,
    last_error: None,
    last_rows: 0,
    last_sessions: 0,
});

pub fn status() -> SyncStatus {
    STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn update_status(f: impl FnOnce(&mut SyncStatus)) {
    f(&mut STATUS.lock().unwrap_or_else(|e| e.into_inner()));
}

/// 同一时间只跑一轮同步（定时、手动、改设置可能撞上）
fn sync_mutex() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 面板地址：用户可能贴面板首页、某个页面或带斜杠的地址，统一成
/// `https://host/基路径`（不带 `/panel` 和结尾的斜杠）。
pub fn normalize_panel_url(raw: &str) -> Result<String, AppError> {
    let mut url = url::Url::parse(raw.trim())
        .map_err(|e| AppError::InvalidInput(format!("Pigger 面板地址无效: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") || !url.has_host() {
        return Err(AppError::InvalidInput(
            "Pigger 面板地址要以 http:// 或 https:// 开头".to_string(),
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().to_string();
    let mut base = path.as_str();
    let mut from = 0;
    while let Some(idx) = path[from..].find("/panel").map(|i| i + from) {
        let rest = &path[idx + "/panel".len()..];
        if rest.is_empty() || rest.starts_with('/') {
            base = &path[..idx];
            break;
        }
        from = idx + 1;
    }
    let base = base.trim_end_matches('/').to_string();
    url.set_path(&base);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// 这台电脑的设备 ID：第一次同步时生成，存在数据库里
pub fn device_key(db: &Database) -> Result<String, AppError> {
    if let Some(key) = db.get_setting(DEVICE_KEY_SETTING)? {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }
    let key = uuid::Uuid::new_v4().simple().to_string();
    db.set_setting(DEVICE_KEY_SETTING, &key)?;
    Ok(key)
}

/// 没填电脑名时用主机名
pub fn default_device_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        let clean = |s: String| Some(s.trim().to_string()).filter(|s| !s.is_empty());
        std::env::var("COMPUTERNAME")
            .ok()
            .and_then(clean)
            .or_else(|| std::env::var("HOSTNAME").ok().and_then(clean))
            .or_else(|| {
                ["/proc/sys/kernel/hostname", "/etc/hostname"]
                    .iter()
                    .find_map(|p| std::fs::read_to_string(p).ok().and_then(clean))
            })
            .or_else(|| {
                let out = std::process::Command::new("hostname").output().ok()?;
                clean(String::from_utf8_lossy(&out.stdout).into_owned())
            })
            .unwrap_or_else(|| "Pigger Switch".to_string())
    })
    .clone()
}

/// 某天本地零点的 Unix 秒；夏令时跳过零点的日子取当天最早的时刻
fn local_midnight(day: NaiveDate) -> i64 {
    let naive = day.and_hms_opt(0, 0, 0).expect("midnight is valid");
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => dt.timestamp(),
        chrono::LocalResult::None => (naive + chrono::Duration::hours(1))
            .and_local_timezone(Local)
            .earliest()
            .map(|dt| dt.timestamp())
            .unwrap_or_else(|| naive.and_utc().timestamp()),
    }
}

/// 本地数据里最早的一天（明细或按天汇总）
fn earliest_day(db: &Database) -> Result<Option<NaiveDate>, AppError> {
    let conn = lock_conn!(db.conn);
    let day: Option<String> = conn.query_row(
        &format!(
            "SELECT MIN(day) FROM (
                SELECT date(MIN(created_at), 'unixepoch', 'localtime') AS day
                FROM proxy_request_logs WHERE app_type IN ({SYNCED_APPS_SQL})
                UNION ALL
                SELECT MIN(date) FROM usage_daily_rollups WHERE app_type IN ({SYNCED_APPS_SQL})
            )"
        ),
        [],
        |row| row.get(0),
    )?;
    Ok(day.and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok()))
}

/// from..to 每天按应用、项目、模型汇总：明细（去重后）和 30 天前的按天汇总合在一起，
/// 分组口径和用量面板一样，输入 token 统一成不含缓存的口径。
pub fn daily_rows(
    db: &Database,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<ReportDay>, AppError> {
    let start = local_midnight(from);
    let end = local_midnight(to + chrono::Duration::days(1));
    let conn = lock_conn!(db.conn);
    let effective = effective_usage_log_filter_for_range(&conn, "l", Some(start), Some(end))?;
    let (app_l, app_r) = (
        folded_app_type_sql("l.app_type"),
        folded_app_type_sql("r.app_type"),
    );
    let (model_l, model_r) = (effective_model_sql("l"), effective_model_sql("r"));
    let (fresh_l, fresh_r) = (fresh_input_sql("l"), fresh_input_sql("r"));
    let sql = format!(
        "SELECT day, app, project, model, SUM(requests), SUM(input), SUM(output),
                SUM(cache_read), SUM(cache_write), SUM(cost)
         FROM (
            SELECT date(l.created_at, 'unixepoch', 'localtime') AS day, {app_l} AS app,
                   l.project AS project, {model_l} AS model, 1 AS requests,
                   {fresh_l} AS input, l.output_tokens AS output,
                   l.cache_read_tokens AS cache_read, l.cache_creation_tokens AS cache_write,
                   CAST(l.total_cost_usd AS REAL) AS cost
            FROM proxy_request_logs l
            WHERE l.app_type IN ({SYNCED_APPS_SQL})
              AND l.created_at >= ?1 AND l.created_at < ?2 AND {effective}
            UNION ALL
            SELECT r.date, {app_r}, r.project, {model_r}, r.request_count,
                   {fresh_r}, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens,
                   CAST(r.total_cost_usd AS REAL)
            FROM usage_daily_rollups r
            WHERE r.app_type IN ({SYNCED_APPS_SQL}) AND r.date >= ?3 AND r.date <= ?4
         )
         GROUP BY day, app, project, model
         ORDER BY day, app, project, model"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params![
            start,
            end,
            from.format("%Y-%m-%d").to_string(),
            to.format("%Y-%m-%d").to_string()
        ],
        |row| {
            Ok(ReportDay {
                day: row.get(0)?,
                app: row.get(1)?,
                project: row.get(2)?,
                model: row.get(3)?,
                requests: row.get(4)?,
                input_tokens: row.get::<_, i64>(5)?.max(0),
                output_tokens: row.get::<_, i64>(6)?.max(0),
                cache_read_tokens: row.get::<_, i64>(7)?.max(0),
                cache_write_tokens: row.get::<_, i64>(8)?.max(0),
                cost_usd: row.get::<_, f64>(9)?.max(0.0),
            })
        },
    )?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 本地明细里的会话（明细只留 30 天，更早的会话本机已经没有了），
/// 只留 `active_since` 之后还有活动的。
fn session_rows(
    db: &Database,
    now: i64,
    active_since: i64,
) -> Result<Vec<ReportSession>, AppError> {
    let stats = db.get_session_stats(None, Some(now), None, None, None, MAX_SESSIONS)?;
    Ok(stats
        .into_iter()
        .filter(|s| s.last_at >= active_since)
        .filter(|s| s.app_type == "claude" || s.app_type == "codex")
        .map(|s| ReportSession {
            app: s.app_type,
            session_id: s.session_id,
            title: s.title.unwrap_or_default(),
            project: s.project,
            model: s.model,
            requests: s.request_count as i64,
            tokens: s.total_tokens as i64,
            cache_read_tokens: s.cache_read_tokens as i64,
            cost_usd: s.total_cost.parse().unwrap_or(0.0),
            first_at: s.first_at,
            last_at: s.last_at,
        })
        .collect())
}

/// 订阅额度的读数；没登录的工具不报，面板上那张卡会显示「尚未同步」
pub fn report_quota(quota: &SubscriptionQuota) -> Option<ReportQuota> {
    if !matches!(quota.tool.as_str(), "claude" | "codex")
        || matches!(quota.credential_status, CredentialStatus::NotFound)
    {
        return None;
    }
    Some(ReportQuota {
        tool: quota.tool.clone(),
        success: quota.success,
        plan_label: quota
            .plan
            .as_ref()
            .map(|p| p.label.clone())
            .unwrap_or_default(),
        active_until: quota
            .plan
            .as_ref()
            .and_then(|p| p.active_until.clone())
            .unwrap_or_default(),
        tiers: quota
            .tiers
            .iter()
            .map(|t| ReportTier {
                name: t.name.clone(),
                utilization: t.utilization,
                resets_at: t.resets_at.clone().unwrap_or_default(),
            })
            .collect(),
        error: quota
            .error
            .clone()
            .or_else(|| quota.credential_message.clone())
            .unwrap_or_default(),
        queried_at: quota.queried_at.unwrap_or(0),
        estimates: None,
    })
}

/// 托盘和提醒最近一次查到的额度
pub fn quotas_from_cache(cache: &UsageCache) -> Vec<ReportQuota> {
    crate::services::alerts::TOOLS
        .iter()
        .filter_map(|tool| cache.with_subscription(tool, report_quota).flatten())
        .collect()
}

/// 这一轮要发的报告。平时一份：今天和昨天，外加这两天有活动的会话；
/// 全量时从最早那天起每 60 天一份，最后一份带上明细里的全部会话并替换面板上的。
pub fn build_reports(
    db: &Database,
    device: &ReportDevice,
    quotas: &[ReportQuota],
    full: bool,
    today: NaiveDate,
    now: i64,
) -> Result<Vec<Report>, AppError> {
    let recent_from = today - chrono::Duration::days(RECENT_DAYS - 1);
    let from = if full {
        earliest_day(db)?.unwrap_or(today).min(recent_from)
    } else {
        recent_from
    };
    let mut reports = Vec::new();
    let mut chunk_from = from;
    while chunk_from <= today {
        let chunk_to = (chunk_from + chrono::Duration::days(DAYS_PER_REPORT - 1)).min(today);
        reports.push(Report {
            device: device.clone(),
            from: chunk_from.format("%Y-%m-%d").to_string(),
            to: chunk_to.format("%Y-%m-%d").to_string(),
            daily: daily_rows(db, chunk_from, chunk_to)?,
            sessions: Vec::new(),
            sessions_since: 0,
            quotas: Vec::new(),
        });
        chunk_from = chunk_to + chrono::Duration::days(1);
    }
    let last = reports.last_mut().expect("the window always holds today");
    if full {
        // 明细窗口里的会话本机说了算；更早的本机已经没有，面板上的留着
        last.sessions_since = now - DETAIL_RETAIN_DAYS * 86_400;
        last.sessions = session_rows(db, now, last.sessions_since)?;
    } else {
        last.sessions = session_rows(db, now, local_midnight(recent_from))?;
    }
    // 读数成功的工具带上它每个窗口的估算：面板只有按天的用量，算不出窗口里用了多少
    last.quotas = Vec::with_capacity(quotas.len());
    for quota in quotas {
        let mut quota = quota.clone();
        if quota.success {
            quota.estimates = Some(crate::services::quota_windows::build_report(
                db,
                &quota.tool,
                None,
                now,
            )?);
        }
        last.quotas.push(quota);
    }
    Ok(reports)
}

#[derive(Debug, Deserialize)]
struct IngestReply {
    success: bool,
    #[serde(default)]
    msg: String,
}

/// 发一份报告；面板不收时把原因带回来
pub async fn push(
    client: &Client,
    base_url: &str,
    token: &str,
    report: &Report,
) -> Result<(), AppError> {
    let url = format!("{base_url}/panel/api/aiUsage/ingest");
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .json(report)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| AppError::Message(format!("连不上 Pigger 面板: {e}")))?;
    let status = resp.status();
    let hint = match status.as_u16() {
        401 => Some("Pigger 不认这个令牌（HTTP 401）：在 AI 用量页重新连接这台电脑"),
        403 => Some("这个令牌不能上传用量（HTTP 403）：要用 AI 用量页「连接电脑」生成的令牌"),
        404 => {
            Some("找不到 Pigger 面板（HTTP 404）：地址要包含面板的路径，或者面板还没有 AI 用量页")
        }
        _ => None,
    };
    if let Some(hint) = hint {
        return Err(AppError::Message(hint.to_string()));
    }
    if !status.is_success() {
        return Err(AppError::Message(format!("Pigger 面板返回 HTTP {status}")));
    }
    let reply: IngestReply = resp
        .json()
        .await
        .map_err(|e| AppError::Message(format!("Pigger 面板的回复看不懂: {e}")))?;
    if !reply.success {
        return Err(AppError::Message(format!(
            "Pigger 面板没有收下报告: {}",
            reply.msg
        )));
    }
    Ok(())
}

/// 同步一轮的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub reports: u32,
    pub rows: u32,
    pub sessions: u32,
    pub full: bool,
}

/// 设置里的面板地址和令牌；没填时说缺什么
fn configured_target() -> Result<(String, String), AppError> {
    let settings = crate::settings::get_settings();
    let url = settings
        .pigger_url
        .as_deref()
        .ok_or_else(|| AppError::InvalidInput("还没填 Pigger 面板地址".to_string()))?;
    let token = settings
        .pigger_token
        .clone()
        .ok_or_else(|| AppError::InvalidInput("还没填 Pigger 的令牌".to_string()))?;
    Ok((normalize_panel_url(url)?, token))
}

/// 推一轮：查库整理报告、依次发出、记下状态
pub async fn sync_with(
    db: Arc<Database>,
    quotas: Vec<ReportQuota>,
    full: bool,
) -> Result<SyncOutcome, AppError> {
    let _guard = sync_mutex().lock().await;
    let now = chrono::Utc::now().timestamp();
    update_status(|s| {
        s.running = true;
        s.last_attempt_at = Some(now);
    });
    let result = async {
        let (url, token) = configured_target()?;
        let device = ReportDevice {
            key: device_key(&db)?,
            name: crate::settings::get_settings()
                .pigger_device_name
                .unwrap_or_else(default_device_name),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let today = Local::now().date_naive();
        let reports = tokio::task::spawn_blocking(move || {
            build_reports(&db, &device, &quotas, full, today, now)
        })
        .await
        .map_err(|e| AppError::Message(format!("整理报告失败: {e}")))??;
        let client = crate::services::http_client::get();
        let mut outcome = SyncOutcome {
            reports: 0,
            rows: 0,
            sessions: 0,
            full,
        };
        for report in &reports {
            push(&client, &url, &token, report).await?;
            outcome.reports += 1;
            outcome.rows += report.daily.len() as u32;
            outcome.sessions += report.sessions.len() as u32;
        }
        Ok::<_, AppError>(outcome)
    }
    .await;
    update_status(|s| {
        s.running = false;
        match &result {
            Ok(outcome) => {
                s.last_success_at = Some(now);
                if outcome.full {
                    s.last_full_at = Some(now);
                }
                s.last_error = None;
                s.last_rows = outcome.rows;
                s.last_sessions = outcome.sessions;
            }
            Err(e) => s.last_error = Some(e.to_string()),
        }
    });
    result
}

/// 该不该全量：这次运行还没全量成功过，或者上次全量超过一天
pub fn full_sync_due(now: i64) -> bool {
    status()
        .last_full_at
        .is_none_or(|at| now - at >= FULL_SYNC_EVERY_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn normalizes_what_people_paste_as_the_panel_address() {
        let cases = [
            (
                "https://panel.example.com/abc123/panel/",
                "https://panel.example.com/abc123",
            ),
            (
                "https://panel.example.com/abc123/panel/ai-usage?x=1#top",
                "https://panel.example.com/abc123",
            ),
            (
                "https://panel.example.com/abc123/",
                "https://panel.example.com/abc123",
            ),
            (
                "https://panel.example.com/abc123",
                "https://panel.example.com/abc123",
            ),
            (
                "https://panel.example.com/panel",
                "https://panel.example.com",
            ),
            ("http://192.0.2.10:2053", "http://192.0.2.10:2053"),
            (
                "  https://panel.example.com/panelish/panel/x  ",
                "https://panel.example.com/panelish",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(normalize_panel_url(input).unwrap(), want, "{input}");
        }
        assert!(normalize_panel_url("panel.example.com").is_err());
        assert!(normalize_panel_url("ftp://panel.example.com").is_err());
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_log(
        conn: &rusqlite::Connection,
        id: &str,
        app: &str,
        session: &str,
        created_at: i64,
        input: i64,
        cache_read: i64,
        cost: &str,
    ) {
        conn.execute(
            "INSERT INTO proxy_request_logs (request_id, provider_id, app_type, model,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                total_cost_usd, latency_ms, status_code, created_at, data_source, project,
                input_token_semantics, session_id)
             VALUES (?1, '_session', ?2, 'opus', ?3, 10, ?4, 1, ?5, 0, 200, ?6,
                'session_log', '/w/app', ?7, ?8)",
            rusqlite::params![
                id,
                app,
                input,
                cache_read,
                cost,
                created_at,
                // Codex 记的输入含缓存（读和写），Claude 不含
                if app == "codex" { 1 } else { 2 },
                session
            ],
        )
        .unwrap();
    }

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn noon(s: &str) -> i64 {
        local_midnight(day(s)) + 12 * 3600
    }

    // 明细按本地日期分组、Claude 桌面版算进 Claude、Codex 的输入扣掉缓存、
    // 30 天前的按天汇总也算进来，窗口外的日子不出现。
    #[test]
    fn daily_rows_join_details_and_rollups_in_fresh_input_terms() {
        let db = Database::memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            insert_log(
                &conn,
                "a",
                "claude",
                "s1",
                noon("2026-10-05"),
                100,
                900,
                "1.5",
            );
            insert_log(
                &conn,
                "b",
                "claude",
                "s1",
                noon("2026-10-05") + 60,
                50,
                0,
                "0.5",
            );
            insert_log(
                &conn,
                "c",
                "codex",
                "s2",
                noon("2026-10-06"),
                1000,
                600,
                "0.25",
            );
            insert_log(
                &conn,
                "d",
                "claude-desktop",
                "",
                noon("2026-10-06"),
                7,
                0,
                "0.1",
            );
            insert_log(&conn, "e", "claude", "s0", noon("2026-10-01"), 1, 0, "9");
            conn.execute(
                "INSERT INTO usage_daily_rollups (date, app_type, provider_id, model, project,
                    request_count, success_count, input_tokens, output_tokens, cache_read_tokens,
                    cache_creation_tokens, input_token_semantics, total_cost_usd)
                 VALUES ('2026-10-04', 'claude', '_session', 'opus', '/w/app',
                    5, 5, 500, 50, 0, 0, 2, '2.0')",
                [],
            )
            .unwrap();
        }
        let rows = daily_rows(&db, day("2026-10-04"), day("2026-10-06")).unwrap();
        let summary: Vec<(&str, &str, i64, i64, f64)> = rows
            .iter()
            .map(|r| {
                (
                    r.day.as_str(),
                    r.app.as_str(),
                    r.requests,
                    r.input_tokens,
                    r.cost_usd,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("2026-10-04", "claude", 5, 500, 2.0),
                ("2026-10-05", "claude", 2, 150, 2.0),
                ("2026-10-06", "claude", 1, 7, 0.1),
                ("2026-10-06", "codex", 1, 399, 0.25),
            ]
        );
    }

    fn laptop() -> ReportDevice {
        ReportDevice {
            key: "k".repeat(32),
            name: "laptop".into(),
            app_version: "1".into(),
        }
    }

    // 全量从最早那天起每 60 天一份、首尾相接不漏天；会话只在最后一份里，
    // 并替换面板上明细窗口内的会话。
    #[test]
    fn a_full_sync_covers_all_history_in_chunks_and_speaks_for_recent_sessions() {
        let db = Database::memory().unwrap();
        let today = day("2026-10-06");
        let now = noon("2026-10-06");
        {
            let conn = db.conn.lock().unwrap();
            insert_log(
                &conn,
                "old",
                "claude",
                "s-old",
                noon("2026-06-01"),
                1,
                0,
                "1",
            );
            insert_log(&conn, "new", "claude", "s-new", now - 600, 1, 0, "1");
        }
        let full = build_reports(&db, &laptop(), &[], true, today, now).unwrap();
        assert_eq!(full.first().unwrap().from, "2026-06-01");
        assert_eq!(full.last().unwrap().to, "2026-10-06");
        assert_eq!(full.len(), 3, "128 days in 60-day reports");
        for pair in full.windows(2) {
            assert_eq!(
                day(&pair[1].from),
                day(&pair[0].to) + chrono::Duration::days(1),
                "reports must tile the window without gaps"
            );
        }
        let (rest, last) = full.split_at(full.len() - 1);
        assert!(rest
            .iter()
            .all(|r| r.sessions.is_empty() && r.sessions_since == 0));
        assert_eq!(last[0].sessions_since, now - 30 * 86_400);
        let ids: Vec<&str> = last[0]
            .sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["s-new"]);
    }

    // 平时只发今天和昨天，带这两天有活动的会话（会话的数字算上它在明细里的全部请求），
    // 不替换面板上的会话。
    #[test]
    fn a_quick_sync_sends_two_days_and_the_sessions_active_in_them() {
        let db = Database::memory().unwrap();
        let today = day("2026-10-06");
        let now = noon("2026-10-06");
        {
            let conn = db.conn.lock().unwrap();
            insert_log(
                &conn,
                "a1",
                "claude",
                "s-long",
                noon("2026-10-01"),
                1,
                0,
                "3",
            );
            insert_log(
                &conn,
                "a2",
                "claude",
                "s-long",
                noon("2026-10-05"),
                1,
                0,
                "1",
            );
            insert_log(
                &conn,
                "b1",
                "claude",
                "s-idle",
                noon("2026-10-03"),
                1,
                0,
                "5",
            );
        }
        let quick = build_reports(&db, &laptop(), &[], false, today, now).unwrap();
        assert_eq!(quick.len(), 1);
        let report = &quick[0];
        assert_eq!(
            (report.from.as_str(), report.to.as_str()),
            ("2026-10-05", "2026-10-06")
        );
        assert_eq!(report.sessions_since, 0);
        assert_eq!(report.sessions.len(), 1);
        assert_eq!(report.sessions[0].session_id, "s-long");
        assert_eq!(report.sessions[0].requests, 2);
        assert_eq!(report.sessions[0].cost_usd, 4.0);
    }

    // 读数成功的工具带上它每个窗口的估算，面板拿它画额度卡；读失败的没有
    #[test]
    fn a_reading_carries_the_tools_window_estimates() {
        let db = Database::memory().unwrap();
        let today = day("2026-10-06");
        let now = noon("2026-10-06");
        {
            let conn = db.conn.lock().unwrap();
            insert_log(&conn, "a", "claude", "s1", now - 600, 1, 0, "10");
            conn.execute(
                "INSERT INTO quota_snapshots (tool, tier, resets_at, utilization, observed_at)
                 VALUES ('claude', 'five_hour', ?1, 40.0, ?2)",
                rusqlite::params![now + 3600, now - 300],
            )
            .unwrap();
        }
        let claude = ReportQuota {
            tool: "claude".into(),
            success: true,
            plan_label: "Pro".into(),
            active_until: String::new(),
            tiers: Vec::new(),
            error: String::new(),
            queried_at: 0,
            estimates: None,
        };
        let codex = ReportQuota {
            tool: "codex".into(),
            success: false,
            ..claude.clone()
        };
        let reports = build_reports(&db, &laptop(), &[claude, codex], false, today, now).unwrap();
        let quotas = &reports.last().unwrap().quotas;
        let estimates = quotas[0]
            .estimates
            .as_ref()
            .expect("a reading carries its estimates");
        assert_eq!(estimates.windows.len(), 1);
        assert_eq!(estimates.windows[0].tier, "five_hour");
        // $10 已用时 40%：额度 $25
        let limit = estimates.windows[0].limit.as_ref().unwrap();
        assert!((limit.cost_usd - 25.0).abs() < 1e-6, "{limit:?}");
        assert!(quotas[1].estimates.is_none());
    }

    #[test]
    fn signed_out_tools_are_left_out_and_failures_keep_their_reason() {
        let mut quota = SubscriptionQuota::not_found("claude");
        assert!(report_quota(&quota).is_none());
        quota.credential_status = CredentialStatus::Expired;
        quota.credential_message = Some("token expired".into());
        let reported = report_quota(&quota).expect("an expired login is still reported");
        assert!(!reported.success);
        assert_eq!(reported.error, "token expired");
    }

    /// 只收一个请求的 HTTP 服务：回 `status` 和 `body`，把收到的原始请求交回来
    fn one_shot_server(
        status: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = socket.read(&mut buf).unwrap();
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw);
                let complete = text.find("\r\n\r\n").is_some_and(|head_end| {
                    let length = text[..head_end]
                        .lines()
                        .find_map(|l| {
                            let l = l.to_ascii_lowercase();
                            l.strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    raw.len() >= head_end + 4 + length
                });
                if n == 0 || complete {
                    break;
                }
            }
            let reply = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&raw).into_owned()
        });
        (format!("http://{addr}/base"), handle)
    }

    fn sample_report() -> Report {
        Report {
            device: laptop(),
            from: "2026-10-06".into(),
            to: "2026-10-06".into(),
            daily: Vec::new(),
            sessions: Vec::new(),
            sessions_since: 0,
            quotas: Vec::new(),
        }
    }

    #[tokio::test]
    async fn push_posts_the_report_to_the_ingest_endpoint_with_the_token() {
        let client = Client::builder().no_proxy().build().unwrap();
        let (base, server) = one_shot_server("200 OK", r#"{"success":true,"obj":{}}"#);
        push(&client, &base, "upload-only", &sample_report())
            .await
            .unwrap();
        let request = server.join().unwrap();
        assert!(
            request.starts_with("POST /base/panel/api/aiUsage/ingest HTTP/1.1"),
            "{request}"
        );
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer upload-only"));
        assert!(request.contains(r#""sessionsSince":0"#), "{request}");
    }

    #[tokio::test]
    async fn push_says_why_the_panel_refused() {
        let client = Client::builder().no_proxy().build().unwrap();
        let (base, _server) = one_shot_server(
            "200 OK",
            r#"{"success":false,"msg":"day 2026-10-07 is outside the report's window"}"#,
        );
        let err = push(&client, &base, "t", &sample_report())
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("outside the report's window"),
            "{err}"
        );

        let (base, _server) = one_shot_server("403 Forbidden", "{}");
        let err = push(&client, &base, "t", &sample_report())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("连接电脑"), "{err}");
    }
}
