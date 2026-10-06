import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useQueryClient } from "@tanstack/react-query";
import { subscriptionApi } from "@/lib/api/subscription";
import { quotaWindowsKey, subscriptionKeys } from "@/lib/query/subscription";
import { cn } from "@/lib/utils";
import type {
  QuotaTier,
  QuotaTool,
  SubscriptionQuota,
} from "@/types/subscription";

/** 分段额度条的格数 */
const SEGMENTS = 20;

/** 窗口从短到长排；不认识的放最后 */
const TIER_ORDER: Record<string, number> = {
  five_hour: 0,
  seven_day: 1,
  seven_day_opus: 2,
  seven_day_sonnet: 3,
  seven_day_fable: 4,
  "30_day": 5,
};

export function sortTiers(tiers: QuotaTier[]): QuotaTier[] {
  return [...tiers].sort(
    (a, b) => (TIER_ORDER[a.name] ?? 9) - (TIER_ORDER[b.name] ?? 9),
  );
}

/** 当前窗口同样从短到长排 */
export function sortWindows<T extends { tier: string }>(windows: T[]): T[] {
  return [...windows].sort(
    (a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9),
  );
}

export function tierLabel(t: TFunction, name: string, short = false): string {
  const key = short ? `limits.tierShort.${name}` : `limits.tier.${name}`;
  return t(key, { defaultValue: name });
}

/** 0–80% 正常，80% 起提醒，95% 起告急 */
export function tierTone(utilization: number): "normal" | "warning" | "danger" {
  if (utilization >= 95) return "danger";
  if (utilization >= 80) return "warning";
  return "normal";
}

const TONE_FILL = {
  normal: "bg-fg-1",
  warning: "bg-warning",
  danger: "bg-danger",
} as const;

/** 「2h 13m」「3d 4h」 */
export function formatCountdown(
  resetsAt: string | null | undefined,
  now: number,
): string | null {
  if (!resetsAt) return null;
  const diff = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(1, minutes)}m`;
}

/** 每 30 秒重渲染一次，让倒计时跟着走 */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 分段方块额度条：亮起的格子 = 已用比例 */
export function SegmentedBar({
  utilization,
  segments = SEGMENTS,
  className,
}: {
  utilization: number;
  segments?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, utilization));
  const filled = Math.round((clamped / 100) * segments);
  const fill = TONE_FILL[tierTone(clamped)];
  return (
    <div
      className={cn("flex gap-[3px]", className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      {Array.from({ length: segments }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-2.5 min-w-0 flex-1 rounded-[2px]",
            index < filled ? fill : "bg-subtle",
          )}
        />
      ))}
    </div>
  );
}

/** 没有可用额度时的一句话（没登录 / 登录过期 / 出错） */
export function quotaProblem(
  t: TFunction,
  tool: QuotaTool,
  quota: SubscriptionQuota | undefined,
  error: unknown,
): string | null {
  if (!quota) {
    return error ? t("limits.queryFailed", { error: String(error) }) : null;
  }
  if (quota.success) return null;
  switch (quota.credentialStatus) {
    case "not_found":
      return t(`limits.notSignedIn.${tool}`);
    case "expired":
    case "refresh_pending":
      return t(`limits.expired.${tool}`);
    case "parse_error":
      return t("limits.parseError", {
        error: quota.credentialMessage ?? quota.error ?? "",
      });
    default:
      return t("limits.queryFailed", { error: quota.error ?? "" });
  }
}

export function useRefreshQuota(tool: QuotaTool) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const quota = await subscriptionApi.getQuota(tool);
      queryClient.setQueryData(subscriptionKeys.quota(tool), quota);
      await queryClient.invalidateQueries({ queryKey: quotaWindowsKey(tool) });
    } catch {
      await queryClient.invalidateQueries({
        queryKey: subscriptionKeys.quota(tool),
      });
    } finally {
      setRefreshing(false);
    }
  };
  return { refresh, refreshing };
}

/** 窗口的起止：一天以内「10/6 14:00 – 19:00」，更长的「9/30 15:00 – 10/7 15:00」 */
export function formatWindowSpan(
  start: number,
  end: number,
  locale: string,
): string {
  const day = (unix: number) =>
    new Date(unix * 1000).toLocaleDateString(locale, {
      month: "numeric",
      day: "numeric",
    });
  const time = (unix: number) =>
    new Date(unix * 1000).toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });
  const sameDay = day(start) === day(end - 1);
  return sameDay
    ? `${day(start)} ${time(start)} – ${time(end)}`
    : `${day(start)} ${time(start)} – ${day(end)} ${time(end)}`;
}
