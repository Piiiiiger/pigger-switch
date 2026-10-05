use crate::database::Database;
use crate::services::UsageCache;
use std::sync::Arc;

/// 全局应用状态
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    /// 最近一次订阅额度查询结果，托盘和前端共用
    pub usage_cache: Arc<UsageCache>,
}

impl AppState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            usage_cache: Arc::new(UsageCache::new()),
        }
    }
}
