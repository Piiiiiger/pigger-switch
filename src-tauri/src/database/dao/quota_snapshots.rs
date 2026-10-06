//! 订阅额度读数
//!
//! 额度接口只说每个窗口用了百分之几、什么时候重置。每次查到都记一笔，
//! 和本机日志里同一段时间的用量放在一起，就能估出窗口的实际额度。

use rusqlite::{params, OptionalExtension};

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::services::subscription::SubscriptionQuota;

/// 读数留多久：明细只留 30 天，再早的窗口算不出本机用量
const SNAPSHOT_RETAIN_SECS: i64 = 45 * 86_400;

#[derive(Debug, Clone, PartialEq)]
pub struct QuotaSnapshot {
    pub tier: String,
    /// 窗口的重置时间（Unix 秒，取到整分钟）
    pub resets_at: i64,
    pub utilization: f64,
    /// 第一次看到这个百分比的时间
    pub observed_at: i64,
    pub plan: String,
}

/// 重置时间取到整分钟：同一个窗口几次读数的秒数可能有出入
pub(crate) fn parse_reset_minute(iso: &str) -> Option<i64> {
    let ts = chrono::DateTime::parse_from_rfc3339(iso).ok()?.timestamp();
    Some((ts + 30).div_euclid(60) * 60)
}

impl Database {
    /// 记下一次成功的额度读数。同一窗口的百分比没变时不重复记：留下的是第一次
    /// 看到这个百分比的时刻，那时的本机用量离它刚越过这个百分比最近。
    pub fn record_quota_snapshot(
        &self,
        tool: &str,
        quota: &SubscriptionQuota,
        observed_at: i64,
    ) -> Result<usize, AppError> {
        if !quota.success {
            return Ok(0);
        }
        let plan = quota.plan.as_ref().map(|p| p.label.as_str()).unwrap_or("");
        let conn = lock_conn!(self.conn);
        let mut written = 0;
        for tier in &quota.tiers {
            let Some(resets_at) = tier.resets_at.as_deref().and_then(parse_reset_minute) else {
                continue;
            };
            if !tier.utilization.is_finite() || tier.utilization < 0.0 {
                continue;
            }
            let last: Option<f64> = conn
                .query_row(
                    "SELECT utilization FROM quota_snapshots
                     WHERE tool = ?1 AND tier = ?2 AND resets_at = ?3
                     ORDER BY observed_at DESC LIMIT 1",
                    params![tool, tier.name, resets_at],
                    |row| row.get(0),
                )
                .optional()?;
            if last.is_some_and(|u| (u - tier.utilization).abs() < 1e-9) {
                continue;
            }
            written += conn.execute(
                "INSERT OR IGNORE INTO quota_snapshots
                    (tool, tier, resets_at, utilization, observed_at, plan)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    tool,
                    tier.name,
                    resets_at,
                    tier.utilization,
                    observed_at,
                    plan
                ],
            )?;
        }
        conn.execute(
            "DELETE FROM quota_snapshots WHERE observed_at < ?1",
            params![observed_at - SNAPSHOT_RETAIN_SECS],
        )?;
        Ok(written)
    }

    /// 一个工具自 `since` 起记下的全部读数，按记下的先后
    pub fn quota_snapshots(&self, tool: &str, since: i64) -> Result<Vec<QuotaSnapshot>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn.prepare(
            "SELECT tier, resets_at, utilization, observed_at, plan FROM quota_snapshots
             WHERE tool = ?1 AND observed_at >= ?2
             ORDER BY observed_at, tier",
        )?;
        let rows = stmt.query_map(params![tool, since], |row| {
            Ok(QuotaSnapshot {
                tier: row.get(0)?,
                resets_at: row.get(1)?,
                utilization: row.get(2)?,
                observed_at: row.get(3)?,
                plan: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::subscription::{CredentialStatus, QuotaTier, SubscriptionQuota};

    fn quota(five_hour: f64, weekly: f64) -> SubscriptionQuota {
        SubscriptionQuota {
            tool: "claude".into(),
            credential_status: CredentialStatus::Valid,
            credential_message: None,
            success: true,
            tiers: vec![
                QuotaTier {
                    name: "five_hour".into(),
                    utilization: five_hour,
                    resets_at: Some("2026-10-06T05:00:00.412+00:00".into()),
                },
                QuotaTier {
                    name: "seven_day".into(),
                    utilization: weekly,
                    resets_at: Some("2026-10-09T15:00:00Z".into()),
                },
                // 没有重置时间的窗口放不进时间轴，不记
                QuotaTier {
                    name: "seven_day_opus".into(),
                    utilization: 3.0,
                    resets_at: None,
                },
            ],
            extra_usage: None,
            reset_credits: None,
            plan: None,
            error: None,
            queried_at: None,
        }
    }

    #[test]
    fn keeps_the_first_time_each_percentage_was_seen() {
        let db = Database::memory().unwrap();
        assert_eq!(
            db.record_quota_snapshot("claude", &quota(10.0, 20.0), 1_000)
                .unwrap(),
            2
        );
        // 百分比没变：不再记
        assert_eq!(
            db.record_quota_snapshot("claude", &quota(10.0, 20.0), 1_300)
                .unwrap(),
            0
        );
        // 5 小时窗口涨了：只记它
        assert_eq!(
            db.record_quota_snapshot("claude", &quota(12.0, 20.0), 1_600)
                .unwrap(),
            1
        );

        let rows = db.quota_snapshots("claude", 0).unwrap();
        let summary: Vec<(&str, f64, i64)> = rows
            .iter()
            .map(|s| (s.tier.as_str(), s.utilization, s.observed_at))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("five_hour", 10.0, 1_000),
                ("seven_day", 20.0, 1_000),
                ("five_hour", 12.0, 1_600)
            ]
        );
        // 带毫秒的重置时间取到整分钟
        assert_eq!(
            rows[0].resets_at,
            parse_reset_minute("2026-10-06T05:00:00Z").unwrap()
        );
        assert!(db.quota_snapshots("codex", 0).unwrap().is_empty());
    }

    #[test]
    fn drops_readings_older_than_the_detail_it_is_compared_with() {
        let db = Database::memory().unwrap();
        db.record_quota_snapshot("claude", &quota(10.0, 20.0), 1_000)
            .unwrap();
        db.record_quota_snapshot(
            "claude",
            &quota(11.0, 21.0),
            1_000 + SNAPSHOT_RETAIN_SECS + 1,
        )
        .unwrap();
        let rows = db.quota_snapshots("claude", 0).unwrap();
        assert!(rows.iter().all(|s| s.observed_at > 1_000), "{rows:?}");
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn failed_readings_are_not_recorded() {
        let db = Database::memory().unwrap();
        let mut failed = quota(10.0, 20.0);
        failed.success = false;
        assert_eq!(
            db.record_quota_snapshot("claude", &failed, 1_000).unwrap(),
            0
        );
        assert!(db.quota_snapshots("claude", 0).unwrap().is_empty());
    }
}
