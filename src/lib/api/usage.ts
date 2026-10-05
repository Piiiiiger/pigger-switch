import { invoke } from "@tauri-apps/api/core";
import type {
  UsageSummary,
  UsageSummaryByApp,
  DailyStats,
  ProjectStats,
  ModelStats,
  SessionStats,
  HourlyActivity,
  BudgetStatus,
  RequestLog,
  LogFilters,
  ModelPricing,
  ModelsDevSyncConfig,
  ModelsDevSyncState,
  PaginatedLogs,
  SessionSyncResult,
  DataSourceSummary,
} from "@/types/usage";

export const usageApi = {
  getUsageSummary: async (
    startDate?: number,
    endDate?: number,
    appType?: string,
    project?: string,
    model?: string,
  ): Promise<UsageSummary> => {
    return invoke("get_usage_summary", {
      startDate,
      endDate,
      appType,
      project,
      model,
    });
  },

  getSessionUsageSummary: async (
    appType: string,
    sessionId: string,
  ): Promise<UsageSummary> => {
    return invoke("get_session_usage_summary", { appType, sessionId });
  },

  getUsageSummaryByApp: async (
    startDate?: number,
    endDate?: number,
    project?: string,
    model?: string,
  ): Promise<UsageSummaryByApp[]> => {
    return invoke("get_usage_summary_by_app", {
      startDate,
      endDate,
      project,
      model,
    });
  },

  getUsageTrends: async (
    startDate?: number,
    endDate?: number,
    appType?: string,
    project?: string,
    model?: string,
  ): Promise<DailyStats[]> => {
    return invoke("get_usage_trends", {
      startDate,
      endDate,
      appType,
      project,
      model,
    });
  },

  getProjectStats: async (
    startDate?: number,
    endDate?: number,
    appType?: string,
    project?: string,
    model?: string,
  ): Promise<ProjectStats[]> => {
    return invoke("get_project_stats", {
      startDate,
      endDate,
      appType,
      project,
      model,
    });
  },

  getModelStats: async (
    startDate?: number,
    endDate?: number,
    appType?: string,
    project?: string,
    model?: string,
  ): Promise<ModelStats[]> => {
    return invoke("get_model_stats", {
      startDate,
      endDate,
      appType,
      project,
      model,
    });
  },

  getSessionStats: async (
    startDate?: number,
    endDate?: number,
    appType?: string,
    project?: string,
    model?: string,
    limit?: number,
  ): Promise<SessionStats[]> => {
    return invoke("get_session_stats", {
      startDate,
      endDate,
      appType,
      project,
      model,
      limit,
    });
  },

  getHourlyActivity: async (
    startDate?: number,
    endDate?: number,
    appType?: string,
    project?: string,
    model?: string,
  ): Promise<HourlyActivity[]> => {
    return invoke("get_hourly_activity", {
      startDate,
      endDate,
      appType,
      project,
      model,
    });
  },

  getBudgetStatus: async (): Promise<BudgetStatus> => {
    return invoke("get_budget_status");
  },

  getRequestLogs: async (
    filters: LogFilters,
    page: number = 0,
    pageSize: number = 20,
  ): Promise<PaginatedLogs> => {
    return invoke("get_request_logs", {
      filters,
      page,
      pageSize,
    });
  },

  getRequestDetail: async (requestId: string): Promise<RequestLog | null> => {
    return invoke("get_request_detail", { requestId });
  },

  getModelPricing: async (): Promise<ModelPricing[]> => {
    return invoke("get_model_pricing");
  },

  updateModelPricing: async (
    modelId: string,
    displayName: string,
    inputCost: string,
    outputCost: string,
    cacheReadCost: string,
    cacheCreationCost: string,
  ): Promise<void> => {
    return invoke("update_model_pricing", {
      modelId,
      displayName,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheCreationCost,
    });
  },

  updateModelPricingBatch: async (entries: ModelPricing[]): Promise<number> => {
    return invoke("update_model_pricing_batch", { entries });
  },

  getModelsDevSyncConfig: async (): Promise<ModelsDevSyncState> => {
    return invoke("get_models_dev_sync_config");
  },

  saveModelsDevSyncConfig: async (
    config: ModelsDevSyncConfig,
  ): Promise<void> => {
    return invoke("save_models_dev_sync_config", { config });
  },

  recordModelsDevSyncResult: async (
    syncedAt: number | null,
    error: string | null,
  ): Promise<void> => {
    return invoke("record_models_dev_sync_result", { syncedAt, error });
  },

  deleteModelPricing: async (modelId: string): Promise<void> => {
    return invoke("delete_model_pricing", { modelId });
  },

  // Session usage sync
  syncSessionUsage: async (): Promise<SessionSyncResult> => {
    return invoke("sync_session_usage");
  },

  /** 会话日志扫描（后台定时或手动同步）最近一次完成的时间（毫秒）；本次启动后还没扫过时为 null */
  getSessionUsageLastSync: async (): Promise<number | null> => {
    return invoke("get_session_usage_last_sync");
  },

  rebuildCodexUsage: async (): Promise<SessionSyncResult> => {
    return invoke("rebuild_codex_usage");
  },

  getDataSourceBreakdown: async (): Promise<DataSourceSummary[]> => {
    return invoke("get_usage_data_sources");
  },
};
