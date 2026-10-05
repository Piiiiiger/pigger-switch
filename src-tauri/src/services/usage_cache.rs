//! 订阅额度缓存（进程内、写穿式）。
//!
//! 额度查询命令成功时写入；托盘构建菜单时读取。不持久化，进程重启即空，
//! 由下一次自动查询重新填充。

use std::collections::HashMap;
use std::sync::RwLock;

use crate::services::subscription::SubscriptionQuota;

#[derive(Default)]
pub struct UsageCache {
    subscription: RwLock<HashMap<String, SubscriptionQuota>>,
}

impl UsageCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put_subscription(&self, tool: &str, quota: SubscriptionQuota) {
        if let Ok(mut w) = self.subscription.write() {
            w.insert(tool.to_string(), quota);
        }
    }

    /// 以借用形式暴露订阅快照，避免托盘每次重建时深拷贝整个 `SubscriptionQuota`。
    pub fn with_subscription<R>(
        &self,
        tool: &str,
        f: impl FnOnce(&SubscriptionQuota) -> R,
    ) -> Option<R> {
        self.subscription
            .read()
            .ok()
            .and_then(|r| r.get(tool).map(f))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::subscription::CredentialStatus;

    fn fake_quota() -> SubscriptionQuota {
        SubscriptionQuota {
            tool: "claude".to_string(),
            credential_status: CredentialStatus::Valid,
            credential_message: None,
            success: true,
            tiers: vec![],
            extra_usage: None,
            reset_credits: None,
            plan: None,
            error: None,
            queried_at: Some(0),
        }
    }

    #[test]
    fn subscription_round_trip() {
        let cache = UsageCache::new();
        assert!(cache.with_subscription("claude", |q| q.success).is_none());
        cache.put_subscription("claude", fake_quota());
        assert_eq!(cache.with_subscription("claude", |q| q.success), Some(true));
        assert!(cache.with_subscription("codex", |q| q.success).is_none());
    }
}
