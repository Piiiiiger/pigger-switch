import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { subscriptionApi } from "@/lib/api/subscription";
import { usageKeys } from "@/lib/query/usage";
import type { QuotaTool, SubscriptionQuota } from "@/types/subscription";

/** 后台每 5 分钟也会刷新并推送；这里的轮询是窗口开着时的兜底 */
const REFETCH_INTERVAL = 5 * 60 * 1000;

export const subscriptionKeys = {
  all: ["subscription"] as const,
  quota: (tool: QuotaTool) => [...subscriptionKeys.all, tool] as const,
};

/** 额度窗口的估算要跟着本机用量走：挂在 usage 下面，新日志进来时一起刷新 */
export const quotaWindowsKey = (tool: QuotaTool) =>
  [...usageKeys.all, "quota-windows", tool] as const;

export function useQuotaWindows(tool: QuotaTool) {
  return useQuery({
    queryKey: quotaWindowsKey(tool),
    queryFn: () => subscriptionApi.getWindows(tool),
    // 剩余额度和「照这个速度」随时间变，没有新日志也每分钟算一次
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: false,
  });
}

export function useSubscriptionQuota(tool: QuotaTool) {
  return useQuery({
    queryKey: subscriptionKeys.quota(tool),
    queryFn: () => subscriptionApi.getQuota(tool),
    refetchInterval: REFETCH_INTERVAL,
    refetchIntervalInBackground: false,
    staleTime: 60 * 1000,
    retry: 1,
  });
}

/** 后端刷新了额度（后台定时 / 托盘同步）时直接写进缓存，不用再查一遍 */
export function useSubscriptionQuotaBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<{ tool: QuotaTool; data: SubscriptionQuota }>(
      "subscription-quota-updated",
      (event) => {
        const { tool, data } = event.payload;
        if (tool === "claude" || tool === "codex") {
          queryClient.setQueryData(subscriptionKeys.quota(tool), data);
          void queryClient.invalidateQueries({
            queryKey: quotaWindowsKey(tool),
          });
        }
      },
    )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);
}
