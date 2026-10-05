import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppGlyph } from "@/components/shell/AppGlyph";
import { HoverTip } from "@/components/ui/hover-tip";
import { subscriptionApi } from "@/lib/api/subscription";
import {
  subscriptionKeys,
  useSubscriptionQuota,
} from "@/lib/query/subscription";
import { cn } from "@/lib/utils";
import type {
  QuotaTier,
  QuotaTool,
  SubscriptionQuota,
} from "@/types/subscription";

/** 分段额度条的格数 */
const SEGMENTS = 20;

const TOOL_NAME: Record<QuotaTool, string> = {
  claude: "Claude",
  codex: "Codex",
};

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

/**
 * 一个工具的订阅额度卡：方案、各窗口的分段条和重置倒计时、超额用量 / 存下的重置次数。
 * 两张卡并排时高度一致（内容少的那张底部留白）。
 */
export function QuotaCard({ tool }: { tool: QuotaTool }) {
  const { t, i18n } = useTranslation();
  const { data: quota, isLoading, error } = useSubscriptionQuota(tool);
  const { refresh, refreshing } = useRefreshQuota(tool);
  const now = useNow();
  const problem = quotaProblem(t, tool, quota, error);
  const tiers = quota?.success ? sortTiers(quota.tiers) : [];
  const locale = i18n.resolvedLanguage || i18n.language || "en";

  return (
    <section className="flex h-full min-h-[260px] flex-col rounded-panel border border-border bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <AppGlyph app={tool === "codex" ? "codex" : "claude"} size={18} />
        <h2 className="m-0 text-strong font-semibold">{TOOL_NAME[tool]}</h2>
        {quota?.plan && (
          <span
            className="rounded-[5px] bg-subtle px-1.5 text-badge leading-5 text-fg-1"
            title={
              quota.plan.activeUntil
                ? t("limits.activeUntil", {
                    date: new Date(quota.plan.activeUntil).toLocaleDateString(
                      locale,
                    ),
                  })
                : undefined
            }
          >
            {quota.plan.label}
          </span>
        )}
        <div className="flex-1" />
        {quota?.queriedAt != null && (
          <span className="text-caption tabular-nums text-fg-3">
            {new Date(quota.queriedAt).toLocaleTimeString(locale, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
        <HoverTip content={t("limits.refresh")}>
          <button
            type="button"
            aria-label={t("limits.refresh")}
            disabled={refreshing}
            onClick={() => void refresh()}
            className="flex h-7 w-7 items-center justify-center rounded-control text-fg-2 transition-colors hover:bg-subtle hover:text-fg-1 disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </HoverTip>
      </header>

      <div className="flex flex-1 flex-col gap-4 px-4 py-4">
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
          </div>
        ) : problem ? (
          <p className="m-0 text-body text-fg-2">{problem}</p>
        ) : tiers.length === 0 ? (
          <p className="m-0 text-body text-fg-2">{t("limits.noWindows")}</p>
        ) : (
          tiers.map((tier) => {
            const used = Math.max(0, Math.min(100, tier.utilization));
            const countdown = formatCountdown(tier.resetsAt, now);
            const tone = tierTone(used);
            return (
              <div key={tier.name} className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-body font-medium">
                    {tierLabel(t, tier.name)}
                  </span>
                  <span className="flex-1" />
                  <span
                    className={cn(
                      "text-body font-semibold tabular-nums",
                      tone === "warning" && "text-warning-text",
                      tone === "danger" && "text-danger-text",
                    )}
                  >
                    {t("limits.usedPercent", { value: used.toFixed(0) })}
                  </span>
                </div>
                <SegmentedBar utilization={used} />
                <span
                  className="text-caption tabular-nums text-fg-3"
                  title={
                    tier.resetsAt
                      ? new Date(tier.resetsAt).toLocaleString(locale)
                      : undefined
                  }
                >
                  {countdown
                    ? t("limits.resetsIn", {
                        countdown,
                        time: new Date(tier.resetsAt!).toLocaleString(locale, {
                          weekday: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        }),
                      })
                    : t("limits.resetUnknown")}
                </span>
              </div>
            );
          })
        )}
      </div>

      {quota?.success &&
        (quota.extraUsage?.isEnabled ||
          (quota.resetCredits?.expiresAt.length ?? 0) > 0) && (
          <footer className="flex flex-col gap-1 border-t border-border px-4 py-2.5 text-caption text-fg-2">
            {quota.extraUsage?.isEnabled && (
              <span className="tabular-nums">
                {t("limits.extraUsage", {
                  used: (quota.extraUsage.usedCredits ?? 0).toFixed(2),
                  limit:
                    quota.extraUsage.monthlyLimit != null
                      ? quota.extraUsage.monthlyLimit.toFixed(2)
                      : "∞",
                  currency: quota.extraUsage.currency ?? "USD",
                })}
              </span>
            )}
            {(quota.resetCredits?.expiresAt.length ?? 0) > 0 && (
              <span className="tabular-nums">
                {t("limits.resetCredits", {
                  count: quota.resetCredits!.expiresAt.length,
                })}
              </span>
            )}
          </footer>
        )}
    </section>
  );
}
