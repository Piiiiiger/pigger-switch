//! 额度和预算提醒，以及后台定时刷新额度。
//!
//! - 订阅额度：某个窗口的用量越过设置里的百分比时发一次桌面通知；同一个窗口
//!   （同一个重置时间）只提醒一次，重启后也不重复。
//! - 预算：今天 / 本月按 API 价格折算的花费超过预算时各提醒一次。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{Datelike, Local, TimeZone};
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::database::Database;
use crate::error::AppError;
use crate::services::subscription::SubscriptionQuota;
use crate::store::AppState;

/// 后台刷新订阅额度的间隔
const QUOTA_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);

pub const TOOLS: [&str; 2] = ["claude", "codex"];

/// 收到一份额度快照：放进缓存、通知前端和托盘，再看要不要提醒
pub fn record_quota(
    app: &tauri::AppHandle,
    state: &AppState,
    tool: &str,
    quota: &SubscriptionQuota,
) {
    crate::commands::publish_quota(app, state, tool, quota);
    record_quota_snapshot(&state.db, tool, quota);
    if let Some(threshold) = crate::settings::get_settings().quota_alert_percent {
        if let Err(e) = check_quota_alert(app, &state.db, tool, quota, f64::from(threshold)) {
            log::warn!("检查额度提醒失败: {e}");
        }
    }
}

/// 记下额度读数，额度页拿它和本机用量一起估每个窗口的实际额度
pub fn record_quota_snapshot(db: &Database, tool: &str, quota: &SubscriptionQuota) {
    let observed_at = quota
        .queried_at
        .map(|ms| ms / 1000)
        .unwrap_or_else(|| chrono::Utc::now().timestamp());
    if let Err(e) = db.record_quota_snapshot(tool, quota, observed_at) {
        log::warn!("记录 {tool} 额度读数失败: {e}");
    }
}

/// 上一次看到的各窗口用量，用来判断「刚越过」阈值
static LAST_UTILIZATION: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);

fn check_quota_alert(
    app: &tauri::AppHandle,
    db: &Database,
    tool: &str,
    quota: &SubscriptionQuota,
    threshold: f64,
) -> Result<(), AppError> {
    if !quota.success {
        return Ok(());
    }
    let mut guard = LAST_UTILIZATION.lock().unwrap_or_else(|e| e.into_inner());
    let last = guard.get_or_insert_with(HashMap::new);
    for tier in &quota.tiers {
        let key = format!("{tool}:{}", tier.name);
        let previous = last.insert(key.clone(), tier.utilization);
        let crossed = tier.utilization >= threshold && previous.is_none_or(|p| p < threshold);
        if !crossed {
            continue;
        }
        // 同一个窗口（同一个重置时间）只提醒一次
        let window = tier.resets_at.clone().unwrap_or_default();
        let setting_key = format!("quota_alert:{key}");
        if db.get_setting(&setting_key)?.as_deref() == Some(window.as_str()) {
            continue;
        }
        db.set_setting(&setting_key, &window)?;
        let texts = crate::tray::texts();
        let title = texts.quota_alert_title(tool, quota.plan.as_ref().map(|p| p.label.as_str()));
        let body = texts.quota_alert_body(&tier.name, tier.utilization, tier.resets_at.as_deref());
        notify(app, &title, &body);
    }
    Ok(())
}

/// 今天 / 本月的花费和预算
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub today_cost: f64,
    pub month_cost: f64,
    pub daily_budget: Option<f64>,
    pub monthly_budget: Option<f64>,
}

fn local_midnight_ts(date: chrono::NaiveDate) -> i64 {
    let naive = date.and_hms_opt(0, 0, 0).expect("midnight is valid");
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => dt.timestamp(),
        chrono::LocalResult::None => (naive + chrono::Duration::hours(1)).and_utc().timestamp(),
    }
}

pub fn budget_status(db: &Database) -> Result<BudgetStatus, AppError> {
    let now = Local::now();
    let today = now.date_naive();
    let month_start = today.with_day(1).unwrap_or(today);
    let end = now.timestamp();
    let settings = crate::settings::get_settings();
    Ok(BudgetStatus {
        today_cost: db.total_cost_between(local_midnight_ts(today), end)?,
        month_cost: db.total_cost_between(local_midnight_ts(month_start), end)?,
        daily_budget: settings.daily_budget_usd,
        monthly_budget: settings.monthly_budget_usd,
    })
}

/// 同步完一轮后检查预算：超了就提醒（每天 / 每月各一次）
pub fn check_budget(app: &tauri::AppHandle, db: &Database) {
    let settings = crate::settings::get_settings();
    if settings.daily_budget_usd.is_none() && settings.monthly_budget_usd.is_none() {
        return;
    }
    let status = match budget_status(db) {
        Ok(status) => status,
        Err(e) => {
            log::warn!("计算预算状态失败: {e}");
            return;
        }
    };
    let now = Local::now();
    let checks = [
        (
            "budget_alert_day",
            now.format("%Y-%m-%d").to_string(),
            status.today_cost,
            status.daily_budget,
            false,
        ),
        (
            "budget_alert_month",
            now.format("%Y-%m").to_string(),
            status.month_cost,
            status.monthly_budget,
            true,
        ),
    ];
    for (key, period, cost, budget, monthly) in checks {
        let Some(budget) = budget else { continue };
        if cost < budget {
            continue;
        }
        match db.get_setting(key) {
            Ok(Some(last)) if last == period => continue,
            Err(e) => {
                log::warn!("读取预算提醒记录失败: {e}");
                continue;
            }
            _ => {}
        }
        if let Err(e) = db.set_setting(key, &period) {
            log::warn!("记录预算提醒失败: {e}");
            continue;
        }
        let texts = crate::tray::texts();
        notify(
            app,
            &texts.budget_alert_title(monthly),
            &texts.budget_alert_body(cost, budget),
        );
    }
}

fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("发送桌面通知失败: {e}");
    }
}

/// 后台定时刷新两个工具的订阅额度（托盘和提醒都靠它，窗口不开也在跑）
pub fn start_quota_refresh(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(QUOTA_REFRESH_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            refresh_all_quotas(&app).await;
        }
    });
}

pub async fn refresh_all_quotas(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    for tool in TOOLS {
        match crate::services::subscription::get_subscription_quota(tool).await {
            Ok(quota) => record_quota(app, &state, tool, &quota),
            Err(e) => log::debug!("后台刷新 {tool} 额度失败: {e}"),
        }
    }
}
