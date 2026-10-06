import { useTranslation } from "react-i18next";
import { ChevronRight, Gauge } from "lucide-react";
import { fmtUsd } from "@/components/usage/format";
import {
  useQuotaWindows,
  useSubscriptionQuota,
} from "@/lib/query/subscription";
import { cn } from "@/lib/utils";
import type { QuotaTool } from "@/types/subscription";
import {
  SegmentedBar,
  formatCountdown,
  sortWindows,
  tierLabel,
  tierTone,
  useNow,
} from "./quota";

/** 用量页顶部的一条：这个工具每个额度窗口用了多少、大约还剩多少；点开额度页 */
export function ToolLimitsStrip({
  tool,
  onOpenLimits,
}: {
  tool: QuotaTool;
  onOpenLimits?: () => void;
}) {
  const { t } = useTranslation();
  const { data: quota } = useSubscriptionQuota(tool);
  const { data: report } = useQuotaWindows(tool);
  const now = useNow();
  if (!quota?.success || !report || report.windows.length === 0) return null;
  const windows = sortWindows(report.windows).slice(0, 4);

  return (
    <button
      type="button"
      onClick={onOpenLimits}
      className="flex w-full shrink-0 items-center gap-4 rounded-panel border border-border bg-surface px-3.5 py-2.5 text-start transition-colors hover:bg-subtle"
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <Gauge className="h-4 w-4 text-fg-2" />
        <span className="text-body font-medium">{t("nav.limits")}</span>
        {quota.plan && (
          <span className="rounded-[5px] bg-subtle px-1.5 text-badge leading-5">
            {quota.plan.label}
          </span>
        )}
      </span>
      <span
        className="grid min-w-0 flex-1 gap-4"
        style={{
          gridTemplateColumns: `repeat(${windows.length}, minmax(0, 1fr))`,
        }}
      >
        {windows.map((w) => {
          const used = w.estimatedUtilization ?? w.reportedUtilization ?? 0;
          const tone = tierTone(used);
          const countdown = formatCountdown(
            w.end != null ? new Date(w.end * 1000).toISOString() : null,
            now,
          );
          return (
            <span key={w.tier} className="flex min-w-0 flex-col gap-1">
              <span className="flex items-baseline gap-1 text-caption">
                <span className="truncate text-fg-2">
                  {tierLabel(t, w.tier, true)}
                </span>
                <span
                  className={cn(
                    "ms-auto font-semibold tabular-nums",
                    tone === "warning" && "text-warning-text",
                    tone === "danger" && "text-danger-text",
                  )}
                >
                  {Math.round(used)}%
                </span>
              </span>
              <SegmentedBar utilization={used} segments={12} />
              <span className="flex gap-2 truncate text-badge font-normal tabular-nums text-fg-3">
                <span className="truncate">
                  {w.remainingCostUsd != null
                    ? t("limits.strip.left", {
                        cost: fmtUsd(w.remainingCostUsd, 2),
                      })
                    : "\u00a0"}
                </span>
                {countdown && <span className="ms-auto">↻ {countdown}</span>}
              </span>
            </span>
          );
        })}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-fg-3" />
    </button>
  );
}
