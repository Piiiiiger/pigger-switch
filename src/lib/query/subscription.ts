import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { subscriptionApi } from "@/lib/api/subscription";
import type { QuotaTool, SubscriptionQuota } from "@/types/subscription";

/** 后台每 5 分钟也会刷新并推送；这里的轮询是窗口开着时的兜底 */
const REFETCH_INTERVAL = 5 * 60 * 1000;

export const subscriptionKeys = {
  all: ["subscription"] as const,
  quota: (tool: QuotaTool) => [...subscriptionKeys.all, tool] as const,
};

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
