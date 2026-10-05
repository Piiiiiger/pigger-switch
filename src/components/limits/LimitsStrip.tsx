import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { AppGlyph } from "@/components/shell/AppGlyph";
import { useSubscriptionQuota } from "@/lib/query/subscription";
import { cn } from "@/lib/utils";
import type { QuotaTool } from "@/types/subscription";
import {
  SegmentedBar,
  formatCountdown,
  sortTiers,
  tierLabel,
  tierTone,
  useNow,
} from "./QuotaCard";

function StripItem({ tool, onOpen }: { tool: QuotaTool; onOpen?: () => void }) {
  const { t } = useTranslation();
  const { data: quota } = useSubscriptionQuota(tool);
  const now = useNow();
  if (!quota?.success || quota.tiers.length === 0) return null;
  // 窄条里只放最短的两个窗口（通常是 5 小时和 7 天）
  const tiers = sortTiers(quota.tiers).slice(0, 2);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-1 basis-[300px] items-center gap-3 rounded-panel border border-border bg-surface px-3.5 py-2.5 text-start transition-colors hover:bg-subtle"
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <AppGlyph app={tool === "codex" ? "codex" : "claude"} size={16} />
        <span className="text-body font-medium">
          {tool === "codex" ? "Codex" : "Claude"}
        </span>
        {quota.plan && (
          <span className="rounded-[5px] bg-subtle px-1.5 text-badge leading-5">
            {quota.plan.label}
          </span>
        )}
      </span>
      <span className="grid min-w-0 flex-1 grid-cols-2 gap-3">
        {tiers.map((tier) => {
          const tone = tierTone(tier.utilization);
          const countdown = formatCountdown(tier.resetsAt, now);
          return (
            <span key={tier.name} className="flex min-w-0 flex-col gap-1">
              <span className="flex items-baseline gap-1 text-caption">
                <span className="truncate text-fg-2">
                  {tierLabel(t, tier.name, true)}
                </span>
                <span
                  className={cn(
                    "ms-auto font-semibold tabular-nums",
                    tone === "warning" && "text-warning-text",
                    tone === "danger" && "text-danger-text",
                  )}
                >
                  {tier.utilization.toFixed(0)}%
                </span>
              </span>
              <SegmentedBar utilization={tier.utilization} segments={12} />
              <span className="truncate text-badge font-normal tabular-nums text-fg-3">
                {countdown ? `↻ ${countdown}` : " "}
              </span>
            </span>
          );
        })}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-fg-3" />
    </button>
  );
}

/** 用量页顶部的订阅额度条：登录了哪个工具就显示哪个，都没登录时不占位置 */
export function LimitsStrip({ onOpenLimits }: { onOpenLimits?: () => void }) {
  const { t } = useTranslation();
  const claude = useSubscriptionQuota("claude");
  const codex = useSubscriptionQuota("codex");
  const visible = [claude.data, codex.data].some(
    (q) => q?.success && q.tiers.length > 0,
  );
  if (!visible) return null;
  return (
    <section
      aria-label={t("limits.title")}
      className="flex shrink-0 flex-wrap gap-2.5"
    >
      <StripItem tool="claude" onOpen={onOpenLimits} />
      <StripItem tool="codex" onOpen={onOpenLimits} />
    </section>
  );
}
