//! 订阅额度窗口的实际额度
//!
//! 额度接口只给每个窗口用了百分之几、什么时候重置；本机日志知道同一段时间里
//! 花了多少（按 API 价格折算的美元和 token）。两者一比就是窗口的总额度：
//! 总额度 ≈ 已用 ÷ 百分比。只看得到本机的用量：网页版或别的电脑也在用同一个
//! 订阅时，估出来的额度会偏低。

use std::collections::BTreeMap;

use serde::Serialize;

use crate::database::{lock_conn, parse_reset_minute, Database, QuotaSnapshot};
use crate::error::AppError;
use crate::services::sql_helpers::fresh_input_sql;
use crate::services::subscription::SubscriptionQuota;
use crate::services::usage_stats::{effective_model_sql, effective_usage_log_filter_for_range};

const HOUR: i64 = 3600;
const FIVE_HOURS: i64 = 5 * HOUR;
const DAY: i64 = 24 * HOUR;
const WEEK: i64 = 7 * DAY;
/// 本窗口用到这个百分比才直接拿它估：整数百分比在 5% 时差 1 就是两成
const CURRENT_MIN_UTILIZATION: f64 = 10.0;
/// 过去的窗口用到这个百分比才拿来算典型额度
const HISTORY_MIN_UTILIZATION: f64 = 5.0;
/// 历史看多久：明细只留 30 天
const HISTORY_SECS: i64 = 30 * DAY;
/// 典型额度取最近几个窗口的中位数
const TYPICAL_WINDOWS: usize = 8;
/// 历史列表最多列几个窗口
const MAX_HISTORY: usize = 60;

/// 窗口有多长：five_hour、seven_day*，以及 Codex 的 `30_day`、`{n}_hour`、`{n}_day`
pub fn tier_duration(name: &str) -> Option<i64> {
    if name == "five_hour" {
        return Some(FIVE_HOURS);
    }
    if name.starts_with("seven_day") {
        return Some(WEEK);
    }
    let (n, unit) = name.split_once('_')?;
    let n: i64 = n.parse().ok().filter(|n| *n > 0)?;
    match unit {
        "hour" => Some(n * HOUR),
        "day" => Some(n * DAY),
        _ => None,
    }
}

/// 模型专属的周额度只算那个模型的用量
fn tier_model_scope(name: &str) -> Option<&'static str> {
    match name {
        "seven_day_opus" => Some("opus"),
        "seven_day_sonnet" => Some("sonnet"),
        "seven_day_fable" => Some("fable"),
        _ => None,
    }
}

/// 订阅额度按工具算：Claude 的含桌面版，Codex 单独
fn app_types_sql(tool: &str) -> Option<&'static str> {
    match tool {
        "claude" => Some("'claude', 'claude-desktop'"),
        "codex" => Some("'codex'"),
        _ => None,
    }
}

/// 本机一个时间段里的用量
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowUsage {
    pub requests: u64,
    pub cost_usd: f64,
    /// 不含缓存的输入
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// 以上四种 token 之和
    pub total_tokens: u64,
}

#[derive(Debug, Clone)]
struct UsageRow {
    at: i64,
    cost: f64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    /// 小写的计价模型名，模型专属额度按它筛
    model: String,
}

fn load_rows(db: &Database, tool: &str, from: i64, to: i64) -> Result<Vec<UsageRow>, AppError> {
    let Some(apps) = app_types_sql(tool) else {
        return Ok(Vec::new());
    };
    let conn = lock_conn!(db.conn);
    let effective = effective_usage_log_filter_for_range(&conn, "l", Some(from), Some(to))?;
    let fresh = fresh_input_sql("l");
    let model = effective_model_sql("l");
    let sql = format!(
        "SELECT l.created_at, CAST(l.total_cost_usd AS REAL), {fresh}, l.output_tokens,
                l.cache_read_tokens, l.cache_creation_tokens, LOWER({model})
         FROM proxy_request_logs l
         WHERE l.app_type IN ({apps}) AND l.created_at >= ?1 AND l.created_at < ?2
           AND {effective}
         ORDER BY l.created_at"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![from, to], |row| {
        Ok(UsageRow {
            at: row.get(0)?,
            cost: row.get::<_, f64>(1)?.max(0.0),
            input: row.get::<_, i64>(2)?.max(0) as u64,
            output: row.get::<_, i64>(3)?.max(0) as u64,
            cache_read: row.get::<_, i64>(4)?.max(0) as u64,
            cache_write: row.get::<_, i64>(5)?.max(0) as u64,
            model: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// `rows` 按时间排好；[start, end) 里（模型专属额度只算那个模型）的用量
fn usage_in(rows: &[UsageRow], start: i64, end: i64, scope: Option<&str>) -> WindowUsage {
    let first = rows.partition_point(|r| r.at < start);
    let mut usage = WindowUsage::default();
    for row in rows[first..].iter().take_while(|r| r.at < end) {
        if scope.is_some_and(|s| !row.model.contains(s)) {
            continue;
        }
        usage.requests += 1;
        usage.cost_usd += row.cost;
        usage.input_tokens += row.input;
        usage.output_tokens += row.output;
        usage.cache_read_tokens += row.cache_read;
        usage.cache_write_tokens += row.cache_write;
    }
    usage.total_tokens = usage.input_tokens
        + usage.output_tokens
        + usage.cache_read_tokens
        + usage.cache_write_tokens;
    usage
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EstimateBasis {
    /// 本窗口自己的读数
    Current,
    /// 最近几个窗口的中位数（本窗口用得还少，或者刚重置还没有读数）
    Typical,
}

/// 窗口的总额度估算：中间值和可能的范围
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitEstimate {
    pub cost_usd: f64,
    pub cost_low: f64,
    pub cost_high: f64,
    pub tokens: u64,
    pub tokens_low: u64,
    pub tokens_high: u64,
    pub basis: EstimateBasis,
    /// 用到了几个窗口的读数
    pub windows: u32,
}

/// 接口给的多是整数百分比，真实值在 ±0.5 之内；带小数的按 ±0.05
fn utilization_band(utilization: f64) -> (f64, f64) {
    let half = if (utilization - utilization.round()).abs() < 1e-9 {
        0.5
    } else {
        0.05
    };
    ((utilization - half).max(0.1), utilization + half)
}

/// 用一次读数（百分比，和看到它那一刻本窗口的本机用量）估窗口的总额度
fn estimate_from_reading(used: &WindowUsage, utilization: f64) -> Option<LimitEstimate> {
    if utilization <= 0.0 || !utilization.is_finite() || used.cost_usd <= 0.0 {
        return None;
    }
    let (low_pct, high_pct) = utilization_band(utilization);
    let scale = |amount: f64, pct: f64| amount * 100.0 / pct;
    let tokens = used.total_tokens as f64;
    Some(LimitEstimate {
        cost_usd: scale(used.cost_usd, utilization),
        cost_low: scale(used.cost_usd, high_pct),
        cost_high: scale(used.cost_usd, low_pct),
        tokens: scale(tokens, utilization).round() as u64,
        tokens_low: scale(tokens, high_pct).round() as u64,
        tokens_high: scale(tokens, low_pct).round() as u64,
        basis: EstimateBasis::Current,
        windows: 1,
    })
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.total_cmp(b));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

/// 几个窗口各自的估算取中位数；范围是它们各自范围的并集
fn typical_estimate(estimates: &[LimitEstimate]) -> Option<LimitEstimate> {
    if estimates.is_empty() {
        return None;
    }
    let mut costs: Vec<f64> = estimates.iter().map(|e| e.cost_usd).collect();
    let mut tokens: Vec<f64> = estimates.iter().map(|e| e.tokens as f64).collect();
    Some(LimitEstimate {
        cost_usd: median(&mut costs),
        cost_low: estimates
            .iter()
            .map(|e| e.cost_low)
            .fold(f64::INFINITY, f64::min),
        cost_high: estimates.iter().map(|e| e.cost_high).fold(0.0, f64::max),
        tokens: median(&mut tokens).round() as u64,
        tokens_low: estimates.iter().map(|e| e.tokens_low).min().unwrap_or(0),
        tokens_high: estimates.iter().map(|e| e.tokens_high).max().unwrap_or(0),
        basis: EstimateBasis::Typical,
        windows: estimates.len() as u32,
    })
}

/// 额度接口给过读数的一个窗口
#[derive(Debug, Clone)]
struct ReadWindow {
    start: i64,
    end: i64,
    /// 窗口里最高的百分比，和第一次看到它的时间
    peak: f64,
    peak_at: i64,
}

/// 一类窗口的读数按重置时间归成窗口（重置时间从早到晚）
fn read_windows(snapshots: &[QuotaSnapshot], tier: &str, duration: i64) -> Vec<ReadWindow> {
    let mut by_end: BTreeMap<i64, ReadWindow> = BTreeMap::new();
    for s in snapshots.iter().filter(|s| s.tier == tier) {
        let window = by_end.entry(s.resets_at).or_insert(ReadWindow {
            start: s.resets_at - duration,
            end: s.resets_at,
            peak: s.utilization,
            peak_at: s.observed_at,
        });
        if s.utilization > window.peak {
            window.peak = s.utilization;
            window.peak_at = s.observed_at;
        }
    }
    by_end.into_values().collect()
}

/// 用一个读过的窗口自己的峰值读数估它的额度
fn read_window_estimate(
    rows: &[UsageRow],
    window: &ReadWindow,
    scope: Option<&str>,
) -> Option<LimitEstimate> {
    let used = usage_in(rows, window.start, window.peak_at.min(window.end), scope);
    estimate_from_reading(&used, window.peak)
}

/// 最近几个读过的窗口（不含 `exclude_end` 那个）的典型额度
fn typical_for(
    rows: &[UsageRow],
    windows: &[ReadWindow],
    scope: Option<&str>,
    exclude_end: Option<i64>,
) -> Option<LimitEstimate> {
    let estimates: Vec<LimitEstimate> = windows
        .iter()
        .rev()
        .filter(|w| Some(w.end) != exclude_end && w.peak >= HISTORY_MIN_UTILIZATION)
        .filter_map(|w| read_window_estimate(rows, w, scope))
        .take(TYPICAL_WINDOWS)
        .collect();
    typical_estimate(&estimates)
}

/// 当前的一个额度窗口
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentWindow {
    pub tier: String,
    /// 窗口起止（Unix 秒）；接口没给重置时间时为空
    pub start: Option<i64>,
    pub end: Option<i64>,
    /// 接口最近一次的百分比；窗口已经重置、还没有新读数时为空
    pub reported_utilization: Option<f64>,
    pub reported_at: Option<i64>,
    /// 用估出的额度和本机到现在的用量算出的百分比，比接口的读数新
    pub estimated_utilization: Option<f64>,
    pub used: WindowUsage,
    pub limit: Option<LimitEstimate>,
    pub remaining_cost_usd: Option<f64>,
    pub remaining_tokens: Option<u64>,
    /// 照本窗口到现在的速度，到重置时大约用到百分之几
    pub projected_utilization: Option<f64>,
    /// 照这个速度什么时候用完；重置前用不完时为空
    pub exhausts_at: Option<i64>,
    /// 一天以上的窗口：离重置还剩几个 5 小时，平均每个还能用多少
    pub five_hour_windows_left: Option<u32>,
    pub per_five_hour_cost_usd: Option<f64>,
    pub per_five_hour_tokens: Option<u64>,
}

/// 过去（和当前）的一个窗口
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PastWindow {
    pub start: i64,
    pub end: i64,
    /// 边界是定的（读数给的，或每周的重置时刻）；否则是按本机请求推算的
    pub exact: bool,
    pub current: bool,
    pub used: WindowUsage,
    /// 这个窗口里看到的最高百分比
    pub peak_utilization: Option<f64>,
    /// 用这个窗口自己的读数估出的总额度
    pub limit: Option<LimitEstimate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindowsReport {
    pub tool: String,
    pub windows: Vec<CurrentWindow>,
    pub five_hour_history: Vec<PastWindow>,
    pub weekly_history: Vec<PastWindow>,
}

/// 一次读数：来自刚查到的额度，查不到时用记下的最后一次
#[derive(Debug, Clone)]
struct Reading {
    tier: String,
    resets_at: Option<i64>,
    utilization: f64,
    read_at: Option<i64>,
}

fn current_readings(
    quota: Option<&SubscriptionQuota>,
    snapshots: &[QuotaSnapshot],
) -> Vec<Reading> {
    if let Some(quota) = quota.filter(|q| q.success) {
        let read_at = quota.queried_at.map(|ms| ms / 1000);
        return quota
            .tiers
            .iter()
            .map(|t| Reading {
                tier: t.name.clone(),
                resets_at: t.resets_at.as_deref().and_then(parse_reset_minute),
                utilization: t.utilization,
                read_at,
            })
            .collect();
    }
    let mut latest: BTreeMap<&str, &QuotaSnapshot> = BTreeMap::new();
    for s in snapshots {
        latest.insert(&s.tier, s);
    }
    let mut readings: Vec<Reading> = latest
        .into_values()
        .map(|s| Reading {
            tier: s.tier.clone(),
            resets_at: Some(s.resets_at),
            utilization: s.utilization,
            read_at: Some(s.observed_at),
        })
        .collect();
    readings.sort_by_key(|r| (tier_duration(&r.tier).unwrap_or(i64::MAX), r.tier.clone()));
    readings
}

/// 5 小时窗口从第一个请求那一分钟开始（接口给的重置时间正是第一个请求后 5 小时），
/// 到点后的下一个请求开始下一个窗口
fn activity_blocks(rows: &[UsageRow], read: &[ReadWindow], from: i64) -> Vec<(i64, i64)> {
    let mut blocks = Vec::new();
    let mut block_end = i64::MIN;
    for row in rows.iter().filter(|r| r.at >= from) {
        if row.at < block_end || read.iter().any(|w| w.start <= row.at && row.at < w.end) {
            continue;
        }
        let ended_before = read
            .iter()
            .map(|w| w.end)
            .filter(|&end| end <= row.at)
            .max()
            .unwrap_or(i64::MIN);
        let start = (row.at - row.at.rem_euclid(60)).max(ended_before);
        let next_read = read
            .iter()
            .map(|w| w.start)
            .filter(|&s| s > row.at)
            .min()
            .unwrap_or(i64::MAX);
        block_end = (start + FIVE_HOURS).min(next_read);
        blocks.push((start, block_end));
    }
    blocks
}

fn finish_window(
    tier: &str,
    rows: &[UsageRow],
    start: i64,
    end: i64,
    reading: Option<(f64, Option<i64>)>,
    limit: Option<LimitEstimate>,
    now: i64,
) -> CurrentWindow {
    let scope = tier_model_scope(tier);
    let used = usage_in(rows, start, now.min(end), scope);
    let mut window = CurrentWindow {
        tier: tier.to_string(),
        start: Some(start),
        end: Some(end),
        reported_utilization: reading.map(|(u, _)| u),
        reported_at: reading.and_then(|(_, at)| at),
        estimated_utilization: None,
        used,
        limit: None,
        remaining_cost_usd: None,
        remaining_tokens: None,
        projected_utilization: None,
        exhausts_at: None,
        five_hour_windows_left: None,
        per_five_hour_cost_usd: None,
        per_five_hour_tokens: None,
    };
    let Some(limit) = limit else {
        return window;
    };
    let remaining = (limit.cost_usd - used.cost_usd).max(0.0);
    window.estimated_utilization = Some(used.cost_usd / limit.cost_usd * 100.0);
    window.remaining_cost_usd = Some(remaining);
    window.remaining_tokens = Some(limit.tokens.saturating_sub(used.total_tokens));
    // 速度按窗口开始到现在平均
    let elapsed = (now - start).max(60) as f64;
    let rate = used.cost_usd / elapsed;
    let left = (end - now).max(0) as f64;
    window.projected_utilization = Some((used.cost_usd + rate * left) / limit.cost_usd * 100.0);
    if rate > 0.0 && remaining > 0.0 {
        let at = now + (remaining / rate).round() as i64;
        window.exhausts_at = (at < end).then_some(at);
    }
    if end - start >= DAY && end > now {
        let windows_left = ((end - now + FIVE_HOURS - 1) / FIVE_HOURS).max(1);
        window.five_hour_windows_left = Some(windows_left as u32);
        window.per_five_hour_cost_usd = Some(remaining / windows_left as f64);
        window.per_five_hour_tokens = window.remaining_tokens.map(|t| t / windows_left as u64);
    }
    window.limit = Some(limit);
    window
}

fn current_window(
    rows: &[UsageRow],
    snapshots: &[QuotaSnapshot],
    reading: &Reading,
    now: i64,
) -> Option<CurrentWindow> {
    let tier = reading.tier.as_str();
    let scope = tier_model_scope(tier);
    let (Some(duration), Some(resets_at)) = (tier_duration(tier), reading.resets_at) else {
        // 放不进时间轴：只有百分比
        return Some(CurrentWindow {
            tier: tier.to_string(),
            start: None,
            end: None,
            reported_utilization: Some(reading.utilization),
            reported_at: reading.read_at,
            estimated_utilization: None,
            used: WindowUsage::default(),
            limit: None,
            remaining_cost_usd: None,
            remaining_tokens: None,
            projected_utilization: None,
            exhausts_at: None,
            five_hour_windows_left: None,
            per_five_hour_cost_usd: None,
            per_five_hour_tokens: None,
        });
    };
    let windows = read_windows(snapshots, tier, duration);

    if resets_at > now {
        let start = resets_at - duration;
        let read = windows.iter().find(|w| w.end == resets_at);
        // 本窗口的读数：记下的峰值；还没记上时用这次读数
        let current = match read {
            Some(w) => (w.peak >= reading.utilization)
                .then(|| read_window_estimate(rows, w, scope))
                .flatten()
                .map(|e| (e, w.peak)),
            None => None,
        }
        .or_else(|| {
            let at = reading.read_at.unwrap_or(now).min(resets_at);
            estimate_from_reading(&usage_in(rows, start, at, scope), reading.utilization)
                .map(|e| (e, reading.utilization))
        });
        let typical = typical_for(rows, &windows, scope, Some(resets_at));
        let limit = match current {
            Some((estimate, peak)) if peak >= CURRENT_MIN_UTILIZATION => Some(estimate),
            Some((estimate, _)) => typical.or(Some(estimate)),
            None => typical,
        };
        return Some(finish_window(
            tier,
            rows,
            start,
            resets_at,
            Some((reading.utilization, reading.read_at)),
            limit,
            now,
        ));
    }

    // 读数之后窗口已经重置：照典型额度估新窗口
    let typical = typical_for(rows, &windows, scope, None);
    let (start, end) = if duration == FIVE_HOURS {
        let read: Vec<ReadWindow> = windows.into_iter().filter(|w| w.end <= now).collect();
        let (start, end) = activity_blocks(rows, &read, resets_at)
            .into_iter()
            .last()
            .filter(|&(_, end)| end > now)?;
        (start, end)
    } else {
        let periods = (now - resets_at).div_euclid(duration);
        let start = resets_at + periods * duration;
        (start, start + duration)
    };
    Some(finish_window(tier, rows, start, end, None, typical, now))
}

fn five_hour_history(rows: &[UsageRow], snapshots: &[QuotaSnapshot], now: i64) -> Vec<PastWindow> {
    let from = now - HISTORY_SECS;
    let read: Vec<ReadWindow> = read_windows(snapshots, "five_hour", FIVE_HOURS)
        .into_iter()
        .filter(|w| w.end > from && w.start <= now)
        .collect();
    let mut windows: Vec<PastWindow> = read
        .iter()
        .map(|w| PastWindow {
            start: w.start,
            end: w.end,
            exact: true,
            current: w.start <= now && now < w.end,
            used: usage_in(rows, w.start, w.end.min(now), None),
            peak_utilization: Some(w.peak),
            limit: (w.peak >= HISTORY_MIN_UTILIZATION)
                .then(|| read_window_estimate(rows, w, None))
                .flatten(),
        })
        .collect();
    windows.extend(
        activity_blocks(rows, &read, from)
            .into_iter()
            .map(|(start, end)| PastWindow {
                start,
                end,
                exact: false,
                current: start <= now && now < end,
                used: usage_in(rows, start, end.min(now), None),
                peak_utilization: None,
                limit: None,
            }),
    );
    windows.sort_by_key(|w| std::cmp::Reverse(w.start));
    windows.truncate(MAX_HISTORY);
    windows
}

fn weekly_history(
    rows: &[UsageRow],
    snapshots: &[QuotaSnapshot],
    anchor: Option<i64>,
    now: i64,
) -> Vec<PastWindow> {
    let read = read_windows(snapshots, "seven_day", WEEK);
    let Some(anchor) = anchor.or_else(|| read.last().map(|w| w.end)) else {
        return Vec::new();
    };
    // 每周在同一时刻重置：从锚点往前、往后按周排
    let mut end = anchor + (now - anchor).div_euclid(WEEK) * WEEK;
    if end <= now {
        end += WEEK;
    }
    let mut windows = Vec::new();
    while end > now - HISTORY_SECS && windows.len() < MAX_HISTORY {
        let start = end - WEEK;
        let read_window = read.iter().find(|w| w.end == end);
        let used = usage_in(rows, start, end.min(now), None);
        if used.requests > 0 || read_window.is_some() {
            windows.push(PastWindow {
                start,
                end,
                // 每周在同一时刻重置：边界是定的，只是不一定有读数
                exact: true,
                current: start <= now && now < end,
                used,
                peak_utilization: read_window.map(|w| w.peak),
                limit: read_window
                    .filter(|w| w.peak >= HISTORY_MIN_UTILIZATION)
                    .and_then(|w| read_window_estimate(rows, w, None)),
            });
        }
        end -= WEEK;
    }
    windows
}

/// 一个工具的额度窗口：当前每个窗口的估算，以及过去的 5 小时和每周窗口
pub fn build_report(
    db: &Database,
    tool: &str,
    quota: Option<&SubscriptionQuota>,
    now: i64,
) -> Result<QuotaWindowsReport, AppError> {
    let since = now - HISTORY_SECS - WEEK;
    let rows = load_rows(db, tool, since, now + 1)?;
    let snapshots = db.quota_snapshots(tool, since)?;
    let readings = current_readings(quota, &snapshots);

    let windows = readings
        .iter()
        .filter_map(|r| current_window(&rows, &snapshots, r, now))
        .collect();
    let has_five_hour = readings.iter().any(|r| r.tier == "five_hour")
        || snapshots.iter().any(|s| s.tier == "five_hour");
    let five_hour_history = if has_five_hour {
        five_hour_history(&rows, &snapshots, now)
    } else {
        Vec::new()
    };
    let weekly_anchor = readings
        .iter()
        .find(|r| r.tier == "seven_day")
        .and_then(|r| r.resets_at);
    Ok(QuotaWindowsReport {
        tool: tool.to_string(),
        windows,
        five_hour_history,
        weekly_history: weekly_history(&rows, &snapshots, weekly_anchor, now),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::subscription::{CredentialStatus, QuotaTier};

    /// 2026-10-05 00:00 UTC，整点
    const T0: i64 = 1_791_158_400;

    fn insert(db: &Database, id: &str, app: &str, model: &str, at: i64, cost: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO proxy_request_logs (request_id, provider_id, app_type, model,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                total_cost_usd, latency_ms, status_code, created_at, data_source,
                input_token_semantics)
             VALUES (?1, '_session', ?2, ?3, 100, 10, 1000, 0, ?4, 0, 200, ?5, 'session_log', 2)",
            rusqlite::params![id, app, model, cost, at],
        )
        .unwrap();
    }

    fn snapshot(db: &Database, tier: &str, resets_at: i64, utilization: f64, observed_at: i64) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO quota_snapshots (tool, tier, resets_at, utilization, observed_at)
             VALUES ('claude', ?1, ?2, ?3, ?4)",
            rusqlite::params![tier, resets_at, utilization, observed_at],
        )
        .unwrap();
    }

    fn quota(tiers: &[(&str, f64, i64)], queried_at: i64) -> SubscriptionQuota {
        SubscriptionQuota {
            tool: "claude".into(),
            credential_status: CredentialStatus::Valid,
            credential_message: None,
            success: true,
            tiers: tiers
                .iter()
                .map(|&(name, utilization, resets_at)| QuotaTier {
                    name: name.into(),
                    utilization,
                    resets_at: chrono::DateTime::from_timestamp(resets_at, 0)
                        .map(|t| t.to_rfc3339()),
                })
                .collect(),
            extra_usage: None,
            reset_credits: None,
            plan: None,
            error: None,
            queried_at: Some(queried_at * 1000),
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn window_lengths_come_from_the_tier_name() {
        assert_eq!(tier_duration("five_hour"), Some(5 * HOUR));
        assert_eq!(tier_duration("seven_day"), Some(WEEK));
        assert_eq!(tier_duration("seven_day_opus"), Some(WEEK));
        assert_eq!(tier_duration("30_day"), Some(30 * DAY));
        assert_eq!(tier_duration("2_hour"), Some(2 * HOUR));
        assert_eq!(tier_duration("unknown"), None);
        assert_eq!(tier_duration("0_day"), None);
    }

    // 已用 $10 时接口说 40%：额度 $25，整数百分比的范围是 39.5%–40.5%；
    // 之后又用了 $2.5，剩下 $12.5。
    #[test]
    fn the_limit_is_what_was_used_divided_by_the_reported_share() {
        let db = Database::memory().unwrap();
        let resets = T0 + 5 * HOUR;
        insert(&db, "a", "claude", "claude-opus-5-5", T0 + 600, "6");
        insert(
            &db,
            "b",
            "claude-desktop",
            "claude-opus-5-5",
            T0 + 1200,
            "4",
        );
        insert(&db, "c", "claude", "claude-opus-5-5", T0 + 2 * HOUR, "2.5");
        insert(&db, "x", "codex", "gpt-5.5", T0 + 900, "100");
        snapshot(&db, "five_hour", resets, 40.0, T0 + 1800);
        let now = T0 + 2 * HOUR + 60;

        let report = build_report(
            &db,
            "claude",
            Some(&quota(&[("five_hour", 40.0, resets)], T0 + 1800)),
            now,
        )
        .unwrap();
        let w = &report.windows[0];
        assert_eq!((w.start, w.end), (Some(T0), Some(resets)));
        let limit = w.limit.as_ref().unwrap();
        assert_eq!(limit.basis, EstimateBasis::Current);
        assert!(close(limit.cost_usd, 25.0), "{limit:?}");
        assert!(close(limit.cost_low, 10.0 / 0.405) && close(limit.cost_high, 10.0 / 0.395));
        assert!(close(w.used.cost_usd, 12.5));
        assert!(close(w.remaining_cost_usd.unwrap(), 12.5));
        assert!(close(w.estimated_utilization.unwrap(), 50.0));
        // 两个请求的 token（各 1110）在读数时已用，额度按同样比例
        assert_eq!(limit.tokens, (2220.0_f64 * 100.0 / 40.0).round() as u64);
    }

    // 本窗口才 5%：读数太粗，改用之前几个窗口的中位数
    #[test]
    fn a_barely_used_window_takes_the_typical_limit_of_earlier_ones() {
        let db = Database::memory().unwrap();
        for (i, (cost, pct)) in [("10", 50.0), ("12", 40.0), ("9", 45.0)].iter().enumerate() {
            let start = T0 + i as i64 * 6 * HOUR;
            insert(
                &db,
                &format!("p{i}"),
                "claude",
                "claude-opus-5-5",
                start + 60,
                cost,
            );
            snapshot(&db, "five_hour", start + 5 * HOUR, *pct, start + 120);
        }
        let start = T0 + 20 * HOUR;
        insert(&db, "now", "claude", "claude-opus-5-5", start + 60, "1");
        snapshot(&db, "five_hour", start + 5 * HOUR, 5.0, start + 120);
        let now = start + 600;

        let report = build_report(&db, "claude", None, now).unwrap();
        let limit = report.windows[0].limit.as_ref().unwrap();
        assert_eq!(limit.basis, EstimateBasis::Typical);
        assert_eq!(limit.windows, 3);
        // $20、$30、$20 的中位数
        assert!(close(limit.cost_usd, 20.0), "{limit:?}");
        let history = &report.five_hour_history;
        assert_eq!(history.len(), 4);
        assert!(history[0].current && history[0].exact);
        assert!(close(history[1].limit.as_ref().unwrap().cost_usd, 20.0));
    }

    // Opus 的周额度只算 Opus 的用量
    #[test]
    fn a_model_weekly_limit_only_counts_that_model() {
        let db = Database::memory().unwrap();
        let resets = T0 + WEEK;
        insert(&db, "o", "claude", "claude-opus-5-5", T0 + 60, "8");
        insert(&db, "s", "claude", "claude-sonnet-5-5", T0 + 120, "100");
        snapshot(&db, "seven_day_opus", resets, 20.0, T0 + 300);
        let report = build_report(&db, "claude", None, T0 + 600).unwrap();
        let w = &report.windows[0];
        assert_eq!(w.tier, "seven_day_opus");
        assert!(close(w.limit.as_ref().unwrap().cost_usd, 40.0));
        assert!(close(w.used.cost_usd, 8.0));
    }

    // 周额度：剩下的平均分给到重置前的每个 5 小时窗口；照当前速度预计用到多少
    #[test]
    fn weekly_remaining_is_spread_over_the_five_hour_windows_left() {
        let db = Database::memory().unwrap();
        let resets = T0 + WEEK;
        insert(&db, "a", "claude", "claude-opus-5-5", T0 + 60, "50");
        snapshot(&db, "seven_day", resets, 25.0, T0 + 120);
        let now = T0 + 2 * DAY + 2 * HOUR;
        let report = build_report(&db, "claude", None, now).unwrap();
        let w = &report.windows[0];
        assert!(close(w.limit.as_ref().unwrap().cost_usd, 200.0));
        assert!(close(w.remaining_cost_usd.unwrap(), 150.0));
        // 还剩 118 小时：23.6 个 5 小时窗口，算 24 个
        assert_eq!(w.five_hour_windows_left, Some(24));
        assert!(close(w.per_five_hour_cost_usd.unwrap(), 150.0 / 24.0));
        // 50 小时用了 $50：一周到头约 $168，即 84%，用不完
        assert!(close(w.projected_utilization.unwrap(), 84.0));
        assert_eq!(w.exhausts_at, None);
    }

    #[test]
    fn a_fast_pace_says_when_the_window_runs_out() {
        let db = Database::memory().unwrap();
        let resets = T0 + 5 * HOUR;
        insert(&db, "a", "claude", "claude-opus-5-5", T0 + 60, "20");
        snapshot(&db, "five_hour", resets, 50.0, T0 + 120);
        let now = T0 + HOUR;
        let w = build_report(&db, "claude", None, now)
            .unwrap()
            .windows
            .remove(0);
        // $20 用了一小时，额度 $40：再一小时用完
        assert_eq!(w.exhausts_at, Some(now + HOUR));
        assert!(close(w.projected_utilization.unwrap(), 250.0));
    }

    // 读数之后 5 小时窗口已经重置：新窗口从重置后第一个请求那一分钟算
    #[test]
    fn after_a_reset_the_new_five_hour_window_starts_with_the_next_request() {
        let db = Database::memory().unwrap();
        insert(&db, "old", "claude", "claude-opus-5-5", T0 + 60, "10");
        snapshot(&db, "five_hour", T0 + 5 * HOUR, 50.0, T0 + 120);
        insert(
            &db,
            "new",
            "claude",
            "claude-opus-5-5",
            T0 + 7 * HOUR + 1500,
            "5",
        );
        let now = T0 + 8 * HOUR;
        let report = build_report(&db, "claude", None, now).unwrap();
        let w = &report.windows[0];
        let start = T0 + 7 * HOUR + 25 * 60;
        assert_eq!((w.start, w.end), (Some(start), Some(start + 5 * HOUR)));
        assert_eq!(w.reported_utilization, None);
        // 额度用上一个窗口的 $20
        assert_eq!(w.limit.as_ref().unwrap().basis, EstimateBasis::Typical);
        assert!(close(w.estimated_utilization.unwrap(), 25.0));
    }

    // 没有读数的时段按请求推算 5 小时窗口，且不和读过的窗口重叠
    #[test]
    fn unread_hours_are_split_into_blocks_that_avoid_read_windows() {
        let db = Database::memory().unwrap();
        insert(&db, "a", "claude", "claude-opus-5-5", T0 + 10 * 60, "1");
        insert(&db, "b", "claude", "claude-opus-5-5", T0 + 4 * HOUR, "1");
        insert(
            &db,
            "c",
            "claude",
            "claude-opus-5-5",
            T0 + 5 * HOUR + 30 * 60,
            "1",
        );
        // 读过的窗口 07:00–12:00
        insert(&db, "d", "claude", "claude-opus-5-5", T0 + 8 * HOUR, "4");
        snapshot(&db, "five_hour", T0 + 12 * HOUR, 20.0, T0 + 8 * HOUR + 60);
        let report = build_report(&db, "claude", None, T0 + 13 * HOUR).unwrap();
        let spans: Vec<(i64, i64, bool, u64)> = report
            .five_hour_history
            .iter()
            .map(|w| (w.start - T0, w.end - T0, w.exact, w.used.requests))
            .collect();
        assert_eq!(
            spans,
            vec![
                (7 * HOUR, 12 * HOUR, true, 1),
                (5 * HOUR + 30 * 60, 7 * HOUR, false, 1),
                (10 * 60, 5 * HOUR + 10 * 60, false, 2),
            ]
        );
    }

    // 每周窗口从重置时刻往前按周排，没有用量也没有读数的周不列
    #[test]
    fn weekly_windows_line_up_on_the_reset_time() {
        let db = Database::memory().unwrap();
        let resets = T0 + 3 * DAY + 15 * HOUR;
        insert(&db, "this", "claude", "claude-opus-5-5", resets - DAY, "7");
        insert(
            &db,
            "last",
            "claude",
            "claude-opus-5-5",
            resets - WEEK - DAY,
            "3",
        );
        insert(
            &db,
            "older",
            "claude",
            "claude-opus-5-5",
            resets - 3 * WEEK + HOUR,
            "2",
        );
        let now = resets - HOUR;
        let report = build_report(
            &db,
            "claude",
            Some(&quota(&[("seven_day", 35.0, resets)], now - 60)),
            now,
        )
        .unwrap();
        let weeks: Vec<(i64, bool, f64)> = report
            .weekly_history
            .iter()
            .map(|w| (resets - w.end, w.current, w.used.cost_usd))
            .collect();
        assert_eq!(
            weeks,
            vec![(0, true, 7.0), (WEEK, false, 3.0), (2 * WEEK, false, 2.0)]
        );
        // 每周的边界都由重置时刻定，不是推算的
        assert!(report.weekly_history.iter().all(|w| w.exact));
        // 没有 5 小时窗口的读数：不列 5 小时历史
        assert!(report.five_hour_history.is_empty());
    }

    #[test]
    fn a_window_without_usage_or_a_reset_time_has_no_estimate() {
        let db = Database::memory().unwrap();
        let mut q = quota(&[("five_hour", 30.0, T0 + 5 * HOUR)], T0 + 60);
        q.tiers.push(QuotaTier {
            name: "seven_day".into(),
            utilization: 12.0,
            resets_at: None,
        });
        let report = build_report(&db, "claude", Some(&q), T0 + 120).unwrap();
        assert!(report.windows.iter().all(|w| w.limit.is_none()));
        assert_eq!(report.windows[1].start, None);
        assert_eq!(report.windows[1].reported_utilization, Some(12.0));
    }
}
