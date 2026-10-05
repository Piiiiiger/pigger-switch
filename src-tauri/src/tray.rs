//! 系统托盘：今天 / 本月的用量摘要和订阅额度，一眼看完不用开窗口。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{Datelike, Local};
use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::services::subscription::{QuotaTier, SubscriptionQuota};
use crate::store::AppState;

const TRAY_ID: &str = "main";
const MENU_SHOW: &str = "show_main";
const MENU_SYNC: &str = "sync_now";
const MENU_QUIT: &str = "quit";

// ─── 文案 ────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    ZhTw,
    En,
    Ja,
}

pub struct Texts {
    lang: Lang,
}

/// 托盘和通知的文案语言：设置里选的，没选时跟随系统
pub fn texts() -> Texts {
    let configured = crate::settings::get_settings().language;
    let locale = configured
        .or_else(sys_locale::get_locale)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let lang = if locale.starts_with("zh-tw")
        || locale.starts_with("zh-hk")
        || locale.starts_with("zh-hant")
    {
        Lang::ZhTw
    } else if locale.starts_with("zh") {
        Lang::Zh
    } else if locale.starts_with("ja") {
        Lang::Ja
    } else {
        Lang::En
    };
    Texts { lang }
}

impl Texts {
    fn pick(
        &self,
        zh: &'static str,
        zh_tw: &'static str,
        en: &'static str,
        ja: &'static str,
    ) -> &'static str {
        match self.lang {
            Lang::Zh => zh,
            Lang::ZhTw => zh_tw,
            Lang::En => en,
            Lang::Ja => ja,
        }
    }

    fn today(&self) -> &'static str {
        self.pick("今天", "今天", "Today", "今日")
    }
    fn this_month(&self) -> &'static str {
        self.pick("本月", "本月", "This month", "今月")
    }
    fn no_usage(&self) -> &'static str {
        self.pick(
            "还没有用量",
            "還沒有用量",
            "No usage yet",
            "使用量はまだありません",
        )
    }
    fn over_budget(&self) -> &'static str {
        self.pick("已超预算", "已超預算", "over budget", "予算超過")
    }
    fn show(&self) -> &'static str {
        self.pick(
            "打开 Pigger Switch",
            "開啟 Pigger Switch",
            "Open Pigger Switch",
            "Pigger Switch を開く",
        )
    }
    fn sync_now(&self) -> &'static str {
        self.pick("立即同步", "立即同步", "Sync now", "今すぐ同期")
    }
    fn quit(&self) -> &'static str {
        self.pick("退出", "結束", "Quit", "終了")
    }
    fn login_needed(&self) -> &'static str {
        self.pick(
            "需要重新登录",
            "需要重新登入",
            "sign in again",
            "再ログインが必要",
        )
    }

    pub fn tier_label(&self, name: &str) -> String {
        match name {
            "five_hour" => self.pick("5 小时", "5 小時", "5h", "5時間").to_string(),
            "seven_day" => self.pick("7 天", "7 天", "7d", "7日").to_string(),
            "seven_day_opus" => "Opus".to_string(),
            "seven_day_sonnet" => "Sonnet".to_string(),
            "seven_day_fable" => "Fable".to_string(),
            "30_day" => self.pick("30 天", "30 天", "30d", "30日").to_string(),
            other => other.to_string(),
        }
    }

    pub fn quota_alert_title(&self, tool: &str, plan: Option<&str>) -> String {
        let name = tool_display_name(tool);
        let name = match plan {
            Some(plan) => format!("{name} {plan}"),
            None => name.to_string(),
        };
        match self.lang {
            Lang::Zh => format!("{name} 额度快用完了"),
            Lang::ZhTw => format!("{name} 額度快用完了"),
            Lang::En => format!("{name} limit almost reached"),
            Lang::Ja => format!("{name} の上限に近づいています"),
        }
    }

    pub fn quota_alert_body(
        &self,
        tier: &str,
        utilization: f64,
        resets_at: Option<&str>,
    ) -> String {
        let tier = self.tier_label(tier);
        let reset = resets_at
            .and_then(|r| chrono::DateTime::parse_from_rfc3339(r).ok())
            .map(|dt| dt.with_timezone(&Local).format("%m-%d %H:%M").to_string());
        match (self.lang, reset) {
            (Lang::Zh, Some(r)) => format!("{tier}窗口已用 {utilization:.0}%，{r} 重置"),
            (Lang::Zh, None) => format!("{tier}窗口已用 {utilization:.0}%"),
            (Lang::ZhTw, Some(r)) => format!("{tier}視窗已用 {utilization:.0}%，{r} 重置"),
            (Lang::ZhTw, None) => format!("{tier}視窗已用 {utilization:.0}%"),
            (Lang::En, Some(r)) => {
                format!("{utilization:.0}% of the {tier} window used, resets {r}")
            }
            (Lang::En, None) => format!("{utilization:.0}% of the {tier} window used"),
            (Lang::Ja, Some(r)) => format!("{tier}枠を {utilization:.0}% 使用、{r} にリセット"),
            (Lang::Ja, None) => format!("{tier}枠を {utilization:.0}% 使用"),
        }
    }

    pub fn budget_alert_title(&self, monthly: bool) -> String {
        match (self.lang, monthly) {
            (Lang::Zh, false) => "今天的花费超出预算".to_string(),
            (Lang::Zh, true) => "本月的花费超出预算".to_string(),
            (Lang::ZhTw, false) => "今天的花費超出預算".to_string(),
            (Lang::ZhTw, true) => "本月的花費超出預算".to_string(),
            (Lang::En, false) => "Today's spend is over budget".to_string(),
            (Lang::En, true) => "This month's spend is over budget".to_string(),
            (Lang::Ja, false) => "今日の利用額が予算を超えました".to_string(),
            (Lang::Ja, true) => "今月の利用額が予算を超えました".to_string(),
        }
    }

    pub fn budget_alert_body(&self, cost: f64, budget: f64) -> String {
        match self.lang {
            Lang::Zh => format!("按 API 价格折算 ${cost:.2}，预算 ${budget:.2}"),
            Lang::ZhTw => format!("按 API 價格折算 ${cost:.2}，預算 ${budget:.2}"),
            Lang::En => format!("${cost:.2} at API prices, budget ${budget:.2}"),
            Lang::Ja => format!("API 価格換算で ${cost:.2}（予算 ${budget:.2}）"),
        }
    }
}

pub fn tool_display_name(tool: &str) -> &'static str {
    match tool {
        "claude" => "Claude",
        "codex" => "Codex",
        _ => "Unknown",
    }
}

// ─── 格式化 ──────────────────────────────────────────────────────────────────

pub fn format_tokens(tokens: u64) -> String {
    let value = tokens as f64;
    if value >= 1e9 {
        format!("{:.2}B", value / 1e9)
    } else if value >= 1e6 {
        format!("{:.1}M", value / 1e6)
    } else if value >= 1e3 {
        format!("{:.1}K", value / 1e3)
    } else {
        tokens.to_string()
    }
}

pub fn format_usd(cost: f64) -> String {
    if cost >= 100.0 {
        format!("${cost:.0}")
    } else {
        format!("${cost:.2}")
    }
}

fn format_quota_line(texts: &Texts, tool: &str, quota: &SubscriptionQuota) -> Option<String> {
    let mut name = tool_display_name(tool).to_string();
    if let Some(plan) = &quota.plan {
        name = format!("{name} {}", plan.label);
    }
    if !quota.success {
        // 没登录（找不到凭据）的工具不占托盘位置
        return match quota.credential_status {
            crate::services::subscription::CredentialStatus::NotFound => None,
            _ => Some(format!("{name} · {}", texts.login_needed())),
        };
    }
    let tiers: Vec<String> = quota
        .tiers
        .iter()
        .map(|tier: &QuotaTier| {
            format!("{} {:.0}%", texts.tier_label(&tier.name), tier.utilization)
        })
        .collect();
    if tiers.is_empty() {
        return None;
    }
    Some(format!("{name} · {}", tiers.join(" · ")))
}

// ─── 菜单 ────────────────────────────────────────────────────────────────────

struct TraySummary {
    today_lines: Vec<String>,
    month_line: String,
    quota_lines: Vec<String>,
    tooltip: String,
}

fn compute_summary(app: &AppHandle) -> TraySummary {
    let texts = texts();
    let state = app.state::<AppState>();
    let now = Local::now();
    let today = now.date_naive();
    let midnight = today.and_hms_opt(0, 0, 0).expect("valid midnight");
    let today_start = midnight
        .and_local_timezone(Local)
        .earliest()
        .map(|dt| dt.timestamp())
        .unwrap_or_else(|| now.timestamp() - 86_400);
    let month_start = today
        .with_day(1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .and_then(|d| d.and_local_timezone(Local).earliest())
        .map(|dt| dt.timestamp())
        .unwrap_or(today_start);
    let end = now.timestamp();

    let by_app = state
        .db
        .get_usage_summary_by_app(Some(today_start), Some(end), None, None)
        .unwrap_or_default();
    let mut today_cost = 0.0;
    let mut today_tokens = 0u64;
    let mut app_lines = Vec::new();
    for tool in crate::services::alerts::TOOLS {
        if let Some(entry) = by_app.iter().find(|e| e.app_type == tool) {
            let cost = entry.summary.total_cost.parse::<f64>().unwrap_or(0.0);
            today_cost += cost;
            today_tokens += entry.summary.real_total_tokens;
            app_lines.push(format!(
                "    {}  {} · {}",
                tool_display_name(tool),
                format_usd(cost),
                format_tokens(entry.summary.real_total_tokens)
            ));
        }
    }

    let settings = crate::settings::get_settings();
    let mut today_line = if app_lines.is_empty() {
        format!("{}  {}", texts.today(), texts.no_usage())
    } else {
        format!(
            "{}  {} · {} tokens",
            texts.today(),
            format_usd(today_cost),
            format_tokens(today_tokens)
        )
    };
    if settings.daily_budget_usd.is_some_and(|b| today_cost >= b) {
        today_line = format!("{today_line}  ⚠ {}", texts.over_budget());
    }
    let mut today_lines = vec![today_line];
    if app_lines.len() > 1 {
        today_lines.extend(app_lines);
    }

    let month_cost = state.db.total_cost_between(month_start, end).unwrap_or(0.0);
    let mut month_line = format!("{}  {}", texts.this_month(), format_usd(month_cost));
    if settings.monthly_budget_usd.is_some_and(|b| month_cost >= b) {
        month_line = format!("{month_line}  ⚠ {}", texts.over_budget());
    }

    let quota_lines = crate::services::alerts::TOOLS
        .iter()
        .filter_map(|tool| {
            state
                .usage_cache
                .with_subscription(tool, |quota| format_quota_line(&texts, tool, quota))
                .flatten()
        })
        .collect();

    TraySummary {
        today_lines,
        month_line,
        quota_lines,
        tooltip: format!(
            "Pigger Switch · {} {}",
            texts.today(),
            format_usd(today_cost)
        ),
    }
}

fn build_menu(app: &AppHandle, summary: &TraySummary) -> tauri::Result<Menu<Wry>> {
    let texts = texts();
    let info = |id: String, text: &str| MenuItem::with_id(app, id, text, false, None::<&str>);
    let mut builder = MenuBuilder::new(app);
    for (index, line) in summary.today_lines.iter().enumerate() {
        builder = builder.item(&info(format!("today_{index}"), line)?);
    }
    builder = builder.item(&info("month".to_string(), &summary.month_line)?);
    if !summary.quota_lines.is_empty() {
        builder = builder.item(&PredefinedMenuItem::separator(app)?);
        for (index, line) in summary.quota_lines.iter().enumerate() {
            builder = builder.item(&info(format!("quota_{index}"), line)?);
        }
    }
    builder
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItem::with_id(
            app,
            MENU_SHOW,
            texts.show(),
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            MENU_SYNC,
            texts.sync_now(),
            true,
            None::<&str>,
        )?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItem::with_id(
            app,
            MENU_QUIT,
            texts.quit(),
            true,
            None::<&str>,
        )?)
        .build()
}

/// 创建托盘图标（启动时调用一次）
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let summary = compute_summary(app);
    let menu = build_menu(app, &summary)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(&summary.tooltip)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            // Windows / Linux 习惯左键打开窗口、右键出菜单；macOS 左键就出菜单
            if cfg!(not(target_os = "macos")) {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(tray.app_handle());
                }
            }
        })
        .show_menu_on_left_click(cfg!(target_os = "macos"));

    #[cfg(target_os = "macos")]
    {
        const ICON_BYTES: &[u8] = include_bytes!("../icons/tray/macos/statusbar_template_3x.png");
        match tauri::image::Image::from_bytes(ICON_BYTES) {
            Ok(icon) => builder = builder.icon(icon).icon_as_template(true),
            Err(e) => log::warn!("加载 macOS 托盘图标失败: {e}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let tray = builder.build(app)?;
    tray.set_visible(crate::settings::get_settings().show_in_tray)?;
    Ok(())
}

/// 重算菜单内容并替换
fn refresh_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let show = crate::settings::get_settings().show_in_tray;
    if let Err(e) = tray.set_visible(show) {
        log::warn!("设置托盘可见性失败: {e}");
    }
    if !show {
        return;
    }
    let summary = compute_summary(app);
    match build_menu(app, &summary) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                log::warn!("更新托盘菜单失败: {e}");
            }
        }
        Err(e) => log::warn!("构建托盘菜单失败: {e}"),
    }
    let _ = tray.set_tooltip(Some(&summary.tooltip));
}

static REFRESH_SCHEDULED: AtomicBool = AtomicBool::new(false);

/// 合并短时间内的多次刷新请求（同步一轮会触发好几次）
pub fn schedule_tray_refresh(app: &AppHandle) {
    if REFRESH_SCHEDULED.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        REFRESH_SCHEDULED.store(false, Ordering::Release);
        let handle = app.clone();
        // 菜单内容要查库，放到阻塞线程池
        let _ = tauri::async_runtime::spawn_blocking(move || refresh_tray(&handle)).await;
    });
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_SHOW => show_main_window(app),
        MENU_SYNC => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::run_session_sync(&app, true).await;
                crate::services::alerts::refresh_all_quotas(&app).await;
            });
        }
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        let _ = window.set_skip_taskbar(false);
        #[cfg(target_os = "macos")]
        apply_tray_policy(app, true);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "linux")]
        crate::linux_fix::nudge_main_window(window.clone());
    }
}

/// macOS：窗口藏起来时也从 Dock 里藏起来，只留菜单栏图标
#[cfg(target_os = "macos")]
pub fn apply_tray_policy(app: &AppHandle, dock_visible: bool) {
    use tauri::ActivationPolicy;
    let policy = if dock_visible {
        ActivationPolicy::Regular
    } else {
        ActivationPolicy::Accessory
    };
    if let Err(e) = app.set_dock_visibility(dock_visible) {
        log::warn!("设置 Dock 显示状态失败: {e}");
    }
    if let Err(e) = app.set_activation_policy(policy) {
        log::warn!("设置激活策略失败: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_tokens_and_cost_compactly() {
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(12_345), "12.3K");
        assert_eq!(format_tokens(3_200_000), "3.2M");
        assert_eq!(format_tokens(1_500_000_000), "1.50B");
        assert_eq!(format_usd(1.234), "$1.23");
        assert_eq!(format_usd(123.4), "$123");
    }

    #[test]
    fn quota_line_lists_windows_and_hides_missing_logins() {
        let texts = Texts { lang: Lang::En };
        let mut quota = SubscriptionQuota::not_found("claude");
        assert!(format_quota_line(&texts, "claude", &quota).is_none());

        quota.success = true;
        quota.credential_status = crate::services::subscription::CredentialStatus::Valid;
        quota.plan = Some(crate::services::subscription::SubscriptionPlan {
            id: "max".to_string(),
            label: "Max 5x".to_string(),
            active_until: None,
        });
        quota.tiers = vec![
            QuotaTier {
                name: "five_hour".to_string(),
                utilization: 34.4,
                resets_at: None,
            },
            QuotaTier {
                name: "seven_day".to_string(),
                utilization: 12.0,
                resets_at: None,
            },
        ];
        assert_eq!(
            format_quota_line(&texts, "claude", &quota).as_deref(),
            Some("Claude Max 5x · 5h 34% · 7d 12%")
        );
    }
}
