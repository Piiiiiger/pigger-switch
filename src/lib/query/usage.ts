import {
  keepPreviousData,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { usageApi } from "@/lib/api/usage";
import { resolveUsageRange } from "@/lib/usageRange";
import type {
  LogFilters,
  UsageRangeSelection,
  UsageScopeFilters,
} from "@/types/usage";

const DEFAULT_REFETCH_INTERVAL_MS = 30000;

type UsageQueryOptions = {
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
};

type RequestLogsQueryArgs = {
  filters: LogFilters;
  range: UsageRangeSelection;
  page?: number;
  pageSize?: number;
  options?: UsageQueryOptions;
};

/** 时间范围 + 筛选的查询键片段（所有统计查询共用） */
function scopeKey(range: UsageRangeSelection, filters?: UsageScopeFilters) {
  return [
    range.preset,
    range.customStartDate ?? 0,
    range.customEndDate ?? 0,
    range.liveEndTime ?? false,
    filters?.appType ?? null,
    filters?.project ?? null,
    filters?.model ?? null,
  ] as const;
}

// Query keys
export const usageKeys = {
  all: ["usage"] as const,
  scoped: (
    kind: string,
    range: UsageRangeSelection,
    filters?: UsageScopeFilters,
  ) => [...usageKeys.all, kind, ...scopeKey(range, filters)] as const,
  logs: (
    range: UsageRangeSelection,
    filters: LogFilters,
    page: number,
    pageSize: number,
  ) =>
    [
      ...usageKeys.all,
      "logs",
      ...scopeKey(range, filters),
      filters.sessionId ?? "",
      filters.statusCode ?? -1,
      page,
      pageSize,
    ] as const,
  detail: (requestId: string) =>
    [...usageKeys.all, "detail", requestId] as const,
  pricing: () => [...usageKeys.all, "pricing"] as const,
  budget: () => [...usageKeys.all, "budget"] as const,
};

/** 把 UI 侧的 "all" 哨兵归一成 undefined（后端语义：不过滤）。 */
function normalizeScopeFilters(filters?: UsageScopeFilters): UsageScopeFilters {
  return {
    appType: filters?.appType === "all" ? undefined : filters?.appType,
    project: filters?.project,
    model: filters?.model,
  };
}

type ScopedFetcher<T> = (
  startDate: number | undefined,
  endDate: number | undefined,
  filters: UsageScopeFilters,
) => Promise<T>;

/**
 * 统计类查询的公共形状：按时间范围 + 筛选取数。都带 keepPreviousData：换筛选、
 * 时间范围、翻页时先留着上一份数据，新数据到了再换，不让指标闪成「…」。
 */
function useScopedQuery<T>(
  kind: string,
  fetcher: ScopedFetcher<T>,
  range: UsageRangeSelection,
  filters?: UsageScopeFilters,
  options?: UsageQueryOptions & { enabled?: boolean },
) {
  const effective = normalizeScopeFilters(filters);
  return useQuery({
    queryKey: usageKeys.scoped(kind, range, effective),
    queryFn: () => {
      const { startDate, endDate } = resolveUsageRange(range);
      return fetcher(startDate, endDate, effective);
    },
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchInterval: options?.refetchInterval ?? DEFAULT_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: options?.refetchIntervalInBackground ?? false,
  });
}

export function useUsageSummary(
  range: UsageRangeSelection,
  filters?: UsageScopeFilters,
  options?: UsageQueryOptions & { enabled?: boolean },
) {
  return useScopedQuery(
    "summary",
    (start, end, f) =>
      usageApi.getUsageSummary(start, end, f.appType, f.project, f.model),
    range,
    filters,
    options,
  );
}

export function useUsageSummaryByApp(
  range: UsageRangeSelection,
  filters?: Pick<UsageScopeFilters, "project" | "model">,
  options?: UsageQueryOptions,
) {
  return useScopedQuery(
    "summary-by-app",
    (start, end, f) =>
      usageApi.getUsageSummaryByApp(start, end, f.project, f.model),
    range,
    { project: filters?.project, model: filters?.model },
    options,
  );
}

export function useUsageTrends(
  range: UsageRangeSelection,
  filters?: UsageScopeFilters,
  options?: UsageQueryOptions,
) {
  return useScopedQuery(
    "trends",
    (start, end, f) =>
      usageApi.getUsageTrends(start, end, f.appType, f.project, f.model),
    range,
    filters,
    options,
  );
}

export function useProjectStats(
  range: UsageRangeSelection,
  filters?: UsageScopeFilters,
  options?: UsageQueryOptions,
) {
  return useScopedQuery(
    "project-stats",
    (start, end, f) =>
      usageApi.getProjectStats(start, end, f.appType, f.project, f.model),
    range,
    filters,
    options,
  );
}

export function useModelStats(
  range: UsageRangeSelection,
  filters?: UsageScopeFilters,
  options?: UsageQueryOptions,
) {
  return useScopedQuery(
    "model-stats",
    (start, end, f) =>
      usageApi.getModelStats(start, end, f.appType, f.project, f.model),
    range,
    filters,
    options,
  );
}

export function useSessionStats(
  range: UsageRangeSelection,
  filters?: UsageScopeFilters,
  options?: UsageQueryOptions,
) {
  return useScopedQuery(
    "session-stats",
    (start, end, f) =>
      usageApi.getSessionStats(start, end, f.appType, f.project, f.model, 300),
    range,
    filters,
    options,
  );
}

export function useHourlyActivity(
  range: UsageRangeSelection,
  filters?: UsageScopeFilters,
  options?: UsageQueryOptions,
) {
  return useScopedQuery(
    "hourly-activity",
    (start, end, f) =>
      usageApi.getHourlyActivity(start, end, f.appType, f.project, f.model),
    range,
    filters,
    options,
  );
}

export function useBudgetStatus(options?: UsageQueryOptions) {
  return useQuery({
    queryKey: usageKeys.budget(),
    queryFn: () => usageApi.getBudgetStatus(),
    refetchInterval: options?.refetchInterval ?? DEFAULT_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useRequestLogs({
  filters,
  range,
  page = 0,
  pageSize = 20,
  options,
}: RequestLogsQueryArgs) {
  return useQuery({
    queryKey: usageKeys.logs(range, filters, page, pageSize),
    queryFn: () => {
      const effectiveFilters = { ...filters, ...resolveUsageRange(range) };
      return usageApi.getRequestLogs(effectiveFilters, page, pageSize);
    },
    placeholderData: keepPreviousData,
    refetchInterval: options?.refetchInterval ?? DEFAULT_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: options?.refetchIntervalInBackground ?? false,
  });
}

export function useRequestDetail(requestId: string) {
  return useQuery({
    queryKey: usageKeys.detail(requestId),
    queryFn: () => usageApi.getRequestDetail(requestId),
    enabled: !!requestId,
  });
}

/**
 * 会话日志扫描（后台定时或手动同步）最近一次完成的时间（毫秒）。
 * 后台每 60 秒扫一次，这里 30 秒问一次；挂在 usage 下，同步后跟着失效重取。
 */
export function useSessionUsageLastSync() {
  return useQuery({
    queryKey: [...usageKeys.all, "session-last-sync"] as const,
    queryFn: () => usageApi.getSessionUsageLastSync(),
    refetchInterval: DEFAULT_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useModelPricing() {
  return useQuery({
    queryKey: usageKeys.pricing(),
    queryFn: usageApi.getModelPricing,
  });
}

export function useUpdateModelPricing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      modelId: string;
      displayName: string;
      inputCost: string;
      outputCost: string;
      cacheReadCost: string;
      cacheCreationCost: string;
    }) =>
      usageApi.updateModelPricing(
        params.modelId,
        params.displayName,
        params.inputCost,
        params.outputCost,
        params.cacheReadCost,
        params.cacheCreationCost,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
    },
  });
}

export function useDeleteModelPricing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (modelId: string) => usageApi.deleteModelPricing(modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
    },
  });
}
