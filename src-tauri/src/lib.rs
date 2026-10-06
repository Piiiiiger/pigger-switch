mod auto_launch;
mod commands;
mod config;
mod database;
mod error;
#[cfg(target_os = "linux")]
mod linux_fix;
mod panic_hook;
mod services;
mod settings;
mod store;
mod tray;
mod usage;
mod usage_events;

pub use database::Database;
pub use error::AppError;
pub use settings::AppSettings;
pub use store::AppState;

use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_window_state::StateFlags;

/// 后台扫描会话日志的间隔
const SESSION_SYNC_INTERVAL: Duration = Duration::from_secs(60);
/// 每天一次的维护（把 30 天前的明细汇总进按天表）
const DAILY_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Windows 的通知要挂在应用的 AppUserModelID 下才显示应用名和图标
#[cfg(target_os = "windows")]
fn set_windows_app_user_model_id(app: &tauri::AppHandle) {
    let app_id = app.config().identifier.clone();
    let wide: Vec<u16> = app_id.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr())
    };
    if result < 0 {
        log::warn!("设置 Windows AppUserModelID 失败: 0x{result:08X}");
    }
}

fn window_state_flags() -> StateFlags {
    StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED
}

/// 扫描一轮会话日志。`force` 为真时（手动同步、启动首轮）不看自动扫描开关。
pub(crate) async fn run_session_sync(app: &tauri::AppHandle, force: bool) {
    if !force && !settings::get_settings().session_auto_sync_enabled {
        return;
    }
    let state = app.state::<AppState>();
    let db = state.db.clone();
    let _guard = services::session_usage::session_sync_mutex().lock().await;
    let task = tauri::async_runtime::spawn_blocking(move || {
        services::session_usage::sync_all_unlocked(&db)
    });
    match task.await {
        Ok(result) if !result.errors.is_empty() => {
            log::warn!(
                "Session usage sync completed with {} error(s)",
                result.errors.len()
            );
        }
        Ok(_) => {}
        Err(error) => log::warn!("Session usage blocking task failed: {error}"),
    }
    services::alerts::check_budget(app, &state.db);
}

/// 推一轮用量到 Pigger；`force_full` 为真时（手动同步、刚改设置）把全部历史重发一遍
pub(crate) async fn run_pigger_sync(
    app: &tauri::AppHandle,
    force_full: bool,
) -> Result<services::pigger_sync::SyncOutcome, AppError> {
    let state = app.state::<AppState>();
    let quotas = services::pigger_sync::quotas_from_cache(&state.usage_cache);
    let full = force_full || services::pigger_sync::full_sync_due(chrono::Utc::now().timestamp());
    services::pigger_sync::sync_with(state.db.clone(), quotas, full).await
}

/// 同步到 Pigger：打开时每 10 分钟推一次（启动后第一次全量）
fn start_pigger_sync(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(services::pigger_sync::SYNC_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if !settings::get_settings().pigger_sync_enabled {
                continue;
            }
            if let Err(e) = run_pigger_sync(&app, false).await {
                log::warn!("同步到 Pigger 失败: {e}");
            }
        }
    });
}

/// `pigger-switch --sync-once`：不开窗口，扫一遍会话日志、查一次额度，
/// 把全部用量推到 Pigger 后返回退出码（给没有桌面的机器配定时任务用）
pub fn sync_once() -> i32 {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let settings = settings::get_settings();
    if !settings.pigger_sync_enabled {
        eprintln!("同步到 Pigger 没有打开：先在 设置 → 同步到 Pigger 里填好并打开");
        return 2;
    }
    if let Err(e) = services::http_client::apply_proxy(settings.network_proxy_url.as_deref()) {
        eprintln!("网络代理无效，改用系统代理: {e}");
        let _ = services::http_client::apply_proxy(None);
    }
    let db = match Database::init() {
        Ok(db) => Arc::new(db),
        Err(e) => {
            eprintln!("打开用量数据库失败: {e}");
            return 1;
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("启动失败: {e}");
            return 1;
        }
    };
    runtime.block_on(async move {
        let scan_db = db.clone();
        let scan = tokio::task::spawn_blocking(move || {
            services::session_usage::sync_all_unlocked(&scan_db)
        });
        if let Ok(result) = scan.await {
            for error in &result.errors {
                eprintln!("扫描会话日志: {error}");
            }
        }
        let mut quotas = Vec::new();
        for tool in services::alerts::TOOLS {
            match services::subscription::get_subscription_quota(tool).await {
                Ok(quota) => quotas.extend(services::pigger_sync::report_quota(&quota)),
                Err(e) => eprintln!("查询 {tool} 额度失败: {e}"),
            }
        }
        match services::pigger_sync::sync_with(db, quotas, true).await {
            Ok(outcome) => {
                println!(
                    "已同步到 Pigger：{} 份报告、{} 行按天用量、{} 个会话",
                    outcome.reports, outcome.rows, outcome.sessions
                );
                0
            }
            Err(e) => {
                eprintln!("同步到 Pigger 失败: {e}");
                1
            }
        }
    })
}

fn start_background_tasks(app: &tauri::AppHandle) {
    // 会话日志：启动时先回填缺失的费用、扫一轮，之后每分钟一次
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let db = handle.state::<AppState>().db.clone();
        let backfill = tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = db.backfill_missing_usage_costs() {
                log::warn!("Usage cost startup backfill failed: {error}");
            }
        });
        let _ = backfill.await;
        run_session_sync(&handle, true).await;
        // 第一次推送带上启动时这轮扫描的结果
        start_pigger_sync(handle.clone());

        let mut interval = tokio::time::interval(SESSION_SYNC_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        loop {
            interval.tick().await;
            run_session_sync(&handle, false).await;
        }
    });

    // 长时间挂在托盘里时，每天把过期明细汇总一次
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(DAILY_MAINTENANCE_INTERVAL);
        interval.tick().await;
        loop {
            interval.tick().await;
            let db = handle.state::<AppState>().db.clone();
            let _guard = services::session_usage::session_sync_mutex().lock().await;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = db.rollup_and_prune(database::DETAIL_RETAIN_DAYS) {
                    log::warn!("Periodic rollup_and_prune failed: {e}");
                }
            })
            .await;
        }
    });

    // 订阅额度：托盘和提醒靠它，窗口不开也定时刷新
    services::alerts::start_quota_refresh(app.clone());
}

fn init_logging(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

    let log_dir = panic_hook::get_log_dir();
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!("创建日志目录失败: {e}");
    }
    app.handle().plugin(
        tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .targets([
                Target::new(TargetKind::Stdout),
                Target::new(TargetKind::Folder {
                    path: log_dir,
                    file_name: Some("pigger-switch".into()),
                }),
            ])
            .rotation_strategy(RotationStrategy::KeepSome(2))
            .max_file_size(10 * 1024 * 1024)
            .timezone_strategy(TimezoneStrategy::UseLocal)
            .build(),
    )?;
    log::info!(
        "=== Pigger Switch v{} started ===",
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}

/// 打开数据库；失败时弹窗让用户重试或退出
fn open_database(app: &tauri::App) -> Arc<Database> {
    loop {
        match Database::init() {
            Ok(db) => return Arc::new(db),
            Err(e) => {
                log::error!("Failed to init database: {e}");
                let retry = app
                    .dialog()
                    .message(format!(
                        "无法打开用量数据库：\n{}\n\n{e}",
                        database::db_path().display()
                    ))
                    .title("Pigger Switch")
                    .kind(MessageDialogKind::Error)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "重试 / Retry".to_string(),
                        "退出 / Quit".to_string(),
                    ))
                    .blocking_show();
                if !retry {
                    std::process::exit(1);
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    panic_hook::setup_panic_hook();

    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        // 再次启动时唤起已在运行的那个
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }));
    }

    builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let settings = settings::get_settings();
                if settings.minimize_to_tray_on_close && settings.show_in_tray {
                    let _ = window.hide();
                    #[cfg(target_os = "windows")]
                    let _ = window.set_skip_taskbar(true);
                    #[cfg(target_os = "macos")]
                    tray::apply_tray_policy(window.app_handle(), false);
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .setup(|app| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            panic_hook::init_app_config_dir(config::get_app_config_dir());
            init_logging(app)?;
            #[cfg(target_os = "windows")]
            set_windows_app_user_model_id(app.handle());
            usage_events::init(app.handle().clone());

            let db = open_database(app);
            app.manage(AppState::new(db));

            let settings = settings::get_settings();
            if let Err(e) =
                services::http_client::apply_proxy(settings.network_proxy_url.as_deref())
            {
                log::warn!("应用网络代理失败，改用系统代理: {e}");
                let _ = services::http_client::apply_proxy(None);
            }
            // 开机自启以设置为准（安装位置变了时也重新登记一次）
            if settings.launch_on_startup {
                if let Err(e) = auto_launch::enable_auto_launch() {
                    log::warn!("登记开机自启失败: {e}");
                }
            }

            if let Err(e) = tray::create_tray(app.handle()) {
                log::error!("创建托盘失败: {e}");
            }
            start_background_tasks(app.handle());

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "linux")]
                {
                    // 禁用 WebKitGTK 硬件加速，防止 EGL 初始化失败导致白屏
                    let _ = window.with_webview(|webview| {
                        use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};
                        if let Some(settings) = WebViewExt::settings(&webview.inner()) {
                            SettingsExt::set_hardware_acceleration_policy(
                                &settings,
                                HardwareAccelerationPolicy::Never,
                            );
                        }
                    });
                }
                if settings.silent_startup && settings.show_in_tray {
                    let _ = window.hide();
                    #[cfg(target_os = "windows")]
                    let _ = window.set_skip_taskbar(true);
                    #[cfg(target_os = "macos")]
                    tray::apply_tray_policy(app.handle(), false);
                } else {
                    let _ = window.show();
                    #[cfg(target_os = "linux")]
                    linux_fix::nudge_main_window(window.clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // usage statistics
            commands::get_usage_summary,
            commands::get_usage_summary_by_app,
            commands::get_session_usage_summary,
            commands::get_usage_trends,
            commands::get_project_stats,
            commands::get_model_stats,
            commands::get_session_stats,
            commands::get_hourly_activity,
            commands::get_budget_status,
            commands::get_request_logs,
            commands::get_request_detail,
            commands::sync_session_usage,
            commands::get_session_usage_last_sync,
            commands::rebuild_codex_usage,
            commands::get_usage_data_sources,
            // pricing
            commands::get_model_pricing,
            commands::update_model_pricing,
            commands::update_model_pricing_batch,
            commands::delete_model_pricing,
            commands::get_models_dev_sync_config,
            commands::save_models_dev_sync_config,
            commands::record_models_dev_sync_result,
            // subscription quota
            commands::get_subscription_quota,
            // sync to Pigger
            commands::get_pigger_sync_status,
            commands::sync_pigger_now,
            // settings & app
            commands::get_settings,
            commands::save_settings,
            commands::get_app_info,
            commands::import_cc_switch_history,
            commands::save_text_file,
            commands::open_data_dir,
            commands::set_window_theme,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS：点 Dock 图标时把藏起来的窗口叫回来
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main_window(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
