//! 系统托盘：每个工具今天 / 本月的花费和订阅额度各占一块，一眼看完不用开窗口。

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

pub fn format_usd(cost: f64) -> String {
    if cost >= 100.0 {
        format!("${cost:.0}")
    } else {
        format!("${cost:.2}")
    }
}

/// 额度窗口那一行（「5h 34% · 7d 12%」）；没登录的工具没有这一行
fn quota_windows_line(texts: &Texts, quota: &SubscriptionQuota) -> Option<String> {
    if !quota.success {
        return match quota.credential_status {
            crate::services::subscription::CredentialStatus::NotFound => None,
            _ => Some(texts.login_needed().to_string()),
        };
    }
    let tiers: Vec<String> = quota
        .tiers
        .iter()
        .map(|tier: &QuotaTier| {
            format!("{} {:.0}%", texts.tier_label(&tier.name), tier.utilization)
        })
        .collect();
    (!tiers.is_empty()).then(|| tiers.join(" · "))
}

/// 一个工具在托盘里的数
struct ToolFigures<'a> {
    tool: &'a str,
    today_cost: f64,
    month_cost: f64,
    quota: Option<&'a SubscriptionQuota>,
}

/// 一个工具的一块：名字和方案、今天和本月的花费、额度窗口。两个工具各一块，不合计；
/// 这个月没用过、也没登录的工具不占位置。
fn tool_block(texts: &Texts, figures: &ToolFigures) -> Option<Vec<String>> {
    let windows = figures.quota.and_then(|q| quota_windows_line(texts, q));
    if figures.month_cost <= 0.0 && figures.today_cost <= 0.0 && windows.is_none() {
        return None;
    }
    let name = tool_display_name(figures.tool);
    let plan = figures
        .quota
        .filter(|q| q.success)
        .and_then(|q| q.plan.as_ref());
    let mut lines = vec![match plan {
        Some(plan) => format!("{name} · {}", plan.label),
        None => name.to_string(),
    }];
    lines.push(format!(
        "    {} {} · {} {}",
        texts.today(),
        format_usd(figures.today_cost),
        texts.this_month(),
        format_usd(figures.month_cost)
    ));
    if let Some(windows) = windows {
        lines.push(format!("    {windows}"));
    }
    Some(lines)
}

// ─── 菜单 ────────────────────────────────────────────────────────────────────

struct TraySummary {
    /// 每个工具一块
    blocks: Vec<Vec<String>>,
    /// 预算按两个工具的合计设：超了单独一行
    budget_lines: Vec<String>,
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

    let cost_of = |rows: &[crate::services::usage_stats::UsageSummaryByApp], tool: &str| {
        rows.iter()
            .find(|e| e.app_type == tool)
            .and_then(|e| e.summary.total_cost.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let today_rows = state
        .db
        .get_usage_summary_by_app(Some(today_start), Some(end), None, None)
        .unwrap_or_default();
    let month_rows = state
        .db
        .get_usage_summary_by_app(Some(month_start), Some(end), None, None)
        .unwrap_or_default();

    let mut blocks = Vec::new();
    let mut tooltip_parts = Vec::new();
    let mut today_total = 0.0;
    for tool in crate::services::alerts::TOOLS {
        let today_cost = cost_of(&today_rows, tool);
        today_total += today_cost;
        tooltip_parts.push(format!(
            "{} {}",
            tool_display_name(tool),
            format_usd(today_cost)
        ));
        let block = state.usage_cache.with_subscription(tool, |quota| {
            tool_block(
                &texts,
                &ToolFigures {
                    tool,
                    today_cost,
                    month_cost: cost_of(&month_rows, tool),
                    quota: Some(quota),
                },
            )
        });
        let block = match block {
            Some(block) => block,
            None => tool_block(
                &texts,
                &ToolFigures {
                    tool,
                    today_cost,
                    month_cost: cost_of(&month_rows, tool),
                    quota: None,
                },
            ),
        };
        blocks.extend(block);
    }

    let settings = crate::settings::get_settings();
    let mut budget_lines = Vec::new();
    if settings.daily_budget_usd.is_some_and(|b| today_total >= b) {
        budget_lines.push(format!("⚠ {}", texts.budget_alert_title(false)));
    }
    let month_cost = state.db.total_cost_between(month_start, end).unwrap_or(0.0);
    if settings.monthly_budget_usd.is_some_and(|b| month_cost >= b) {
        budget_lines.push(format!("⚠ {}", texts.budget_alert_title(true)));
    }

    TraySummary {
        blocks,
        budget_lines,
        tooltip: format!(
            "Pigger Switch · {} {}",
            texts.today(),
            tooltip_parts.join(" · ")
        ),
    }
}

fn build_menu(app: &AppHandle, summary: &TraySummary) -> tauri::Result<Menu<Wry>> {
    let texts = texts();
    let info = |id: String, text: &str| MenuItem::with_id(app, id, text, false, None::<&str>);
    let mut builder = MenuBuilder::new(app);
    if summary.blocks.is_empty() {
        builder = builder.item(&info("empty".to_string(), texts.no_usage())?);
    }
    for (block_index, block) in summary.blocks.iter().enumerate() {
        if block_index > 0 {
            builder = builder.item(&PredefinedMenuItem::separator(app)?);
        }
        for (index, line) in block.iter().enumerate() {
            builder = builder.item(&info(format!("tool_{block_index}_{index}"), line)?);
        }
    }
    if !summary.budget_lines.is_empty() {
        builder = builder.item(&PredefinedMenuItem::separator(app)?);
        for (index, line) in summary.budget_lines.iter().enumerate() {
            builder = builder.item(&info(format!("budget_{index}"), line)?);
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
    fn formats_cost_compactly() {
        assert_eq!(format_usd(1.234), "$1.23");
        assert_eq!(format_usd(123.4), "$123");
    }

    #[test]
    fn quota_line_lists_windows_and_hides_missing_logins() {
        let texts = Texts { lang: Lang::En };
        let mut quota = SubscriptionQuota::not_found("claude");
        assert!(quota_windows_line(&texts, &quota).is_none());

        quota.success = true;
        quota.credential_status = crate::services::subscription::CredentialStatus::Valid;
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
            quota_windows_line(&texts, &quota).as_deref(),
            Some("5h 34% · 7d 12%")
        );
    }

    // 每个工具一块：名字和方案、它自己的今天和本月、它自己的窗口
    #[test]
    fn each_tool_gets_its_own_block() {
        let texts = Texts { lang: Lang::En };
        let mut quota = SubscriptionQuota::not_found("claude");
        quota.success = true;
        quota.credential_status = crate::services::subscription::CredentialStatus::Valid;
        quota.plan = Some(crate::services::subscription::SubscriptionPlan {
            id: "max".to_string(),
            label: "Max 5x".to_string(),
            active_until: None,
        });
        quota.tiers = vec![QuotaTier {
            name: "five_hour".to_string(),
            utilization: 16.0,
            resets_at: None,
        }];
        let block = tool_block(
            &texts,
            &ToolFigures {
                tool: "claude",
                today_cost: 60.08,
                month_cost: 1917.57,
                quota: Some(&quota),
            },
        );
        assert_eq!(
            block,
            Some(vec![
                "Claude · Max 5x".to_string(),
                "    Today $60.08 · This month $1918".to_string(),
                "    5h 16%".to_string(),
            ])
        );
        // 这个月没用过、也没登录：不占位置
        let unused = tool_block(
            &texts,
            &ToolFigures {
                tool: "codex",
                today_cost: 0.0,
                month_cost: 0.0,
                quota: Some(&SubscriptionQuota::not_found("codex")),
            },
        );
        assert_eq!(unused, None);
    }
}
