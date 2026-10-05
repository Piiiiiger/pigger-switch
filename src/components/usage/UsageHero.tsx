import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { useUsageSummaryByApp } from "@/lib/query/usage";
import { HelpTip } from "@/components/ui/help-tip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { previousUsageRange } from "@/lib/usageRange";
import { APP_COLOR, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import {
  fmtInt,
  fmtUsd,
  formatTokensCompact,
  getLocaleFromLanguage,
  getResolvedLang,
  parseFiniteNumber,
} from "./format";
import {
  getCacheWriteAvailability,
  type UsageRangeSelection,
  type UsageSummary,
  type UsageSummaryByApp,
} from "@/types/usage";

interface UsageHeroProps {
  range: UsageRangeSelection;
  appType?: string;
  project?: string;
  model?: string;
  refreshIntervalMs: number;
  /** 窄容器下指标卡排成两列 */
  compact?: boolean;
}

/**
 * Combine per-app summaries into a single rolled-up summary.
 *
 * The backend's per-app rows already use fresh-input semantics (cache-inclusive
 * providers have been normalized in SQL), so plain addition is correct here.
 * `cacheHitRate` and `successRate` must be re-derived from the summed counts
 * rather than averaged across rows.
 */
export function aggregateSummaries(items: UsageSummary[]): UsageSummary {
  let totalRequests = 0;
  let successCount = 0;
  let totalCostNum = 0;
  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;

  for (const s of items) {
    totalRequests += s.totalRequests;
    successCount += Math.round((s.totalRequests * s.successRate) / 100);
    totalCostNum += parseFiniteNumber(s.totalCost) ?? 0;
    input += s.totalInputTokens;
    output += s.totalOutputTokens;
    cacheCreation += s.totalCacheCreationTokens;
    cacheRead += s.totalCacheReadTokens;
  }

  const cacheableInput = input + cacheCreation + cacheRead;
  return {
    totalRequests,
    totalCost: totalCostNum.toFixed(6),
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCacheCreationTokens: cacheCreation,
    totalCacheReadTokens: cacheRead,
    successRate: totalRequests > 0 ? (successCount / totalRequests) * 100 : 0,
    realTotalTokens: input + output + cacheCreation + cacheRead,
    cacheHitRate: cacheableInput > 0 ? cacheRead / cacheableInput : 0,
  };
}

function pickSummary(
  apps: UsageSummaryByApp[],
  appType: string | undefined,
): UsageSummary | undefined {
  if (apps.length === 0) return undefined;
  if (appType) {
    return apps.find((a) => a.appType === appType)?.summary;
  }
  return aggregateSummaries(apps.map((a) => a.summary));
}

/** 和上一段相比的变化；上一段是 0 时不算百分比 */
function changeRatio(current: number, previous: number | undefined) {
  if (previous == null || previous <= 0) return null;
  return (current - previous) / previous;
}

function MetricCard({
  label,
  help,
  value,
  title,
  change,
  changeTitle,
}: {
  label: string;
  help?: { title: string; body: string };
  value: string;
  title?: string;
  /** 环比（-0.12 = 少了 12%）；null 不显示 */
  change?: number | null;
  changeTitle?: string;
}) {
  return (
    <div className="flex h-[76px] min-w-0 flex-col justify-between rounded-panel border border-border bg-surface px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-0.5">
        <span className="truncate text-caption text-fg-2">{label}</span>
        {help && (
          <HelpTip title={help.title} align="end">
            {help.body}
          </HelpTip>
        )}
        {change != null && Number.isFinite(change) && (
          <span
            className="ms-auto shrink-0 ps-1.5 text-badge tabular-nums text-fg-3"
            title={changeTitle}
          >
            {Math.abs(change) < 0.005 ? "" : change > 0 ? "↑" : "↓"}
            {Math.abs(change * 100) >= 1000
              ? ">999"
              : Math.abs(change * 100).toFixed(0)}
            %
          </span>
        )}
      </div>
      <span
        className="truncate text-metric tabular-nums text-fg-1"
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

/** Claude / Codex 的花费各占多少（只在「全部应用」且两边都有数据时显示） */
function AppSplit({
  apps,
  locale,
}: {
  apps: UsageSummaryByApp[];
  locale: string;
}) {
  const rows = (["claude", "codex"] as const)
    .map((app) => {
      const summary = apps.find((a) => a.appType === app)?.summary;
      return {
        app,
        cost: parseFiniteNumber(summary?.totalCost) ?? 0,
        tokens: summary?.realTotalTokens ?? 0,
      };
    })
    .filter((row) => row.cost > 0 || row.tokens > 0);
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  if (rows.length < 2 || total <= 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-subtle">
        {rows.map((row) => (
          <span
            key={row.app}
            className="h-full"
            style={{
              width: `${(row.cost / total) * 100}%`,
              background: APP_COLOR[row.app],
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-caption text-fg-2">
        {rows.map((row) => (
          <span key={row.app} className="inline-flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: APP_COLOR[row.app] }}
            />
            {APP_DISPLAY_NAME[row.app]}
            <span className="tabular-nums text-fg-1">
              {fmtUsd(row.cost, 2)}
            </span>
            <span className="tabular-nums text-fg-3">
              {((row.cost / total) * 100).toFixed(0)}% ·{" "}
              {formatTokensCompact(row.tokens, locale)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function MiniMetric({
  label,
  value,
  title,
  muted,
  help,
}: {
  label: string;
  value: string;
  title?: string;
  muted?: boolean;
  help?: { title: string; body: string };
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-panel bg-subtle px-3.5 py-2">
      <div className="flex min-w-0 items-center gap-0.5">
        <span className="truncate text-caption text-fg-2">{label}</span>
        {help && <HelpTip title={help.title}>{help.body}</HelpTip>}
      </div>
      <span
        className={cn(
          "truncate text-section tabular-nums",
          muted ? "text-fg-3" : "text-fg-1",
        )}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * 指标区（v7 S6）：默认 4 张卡——总成本、总请求数、真实消耗 Tokens、缓存命中率；
 * 「更多指标」展开新增输入 / Output / 创建 / 命中。
 */
export function UsageHero({
  range,
  appType,
  project,
  model,
  refreshIntervalMs,
  compact = false,
}: UsageHeroProps) {
  const { t, i18n } = useTranslation();
  const locale = getLocaleFromLanguage(getResolvedLang(i18n));
  const [moreOpen, setMoreOpen] = useState(false);

  const { data, isLoading } = useUsageSummaryByApp(
    range,
    { project, model },
    {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  );

  // 环比：上一个同样长的时间段（「全部」没有）
  const previousRange = useMemo(
    () => previousUsageRange(range),
    // 预设范围的上一段随时间平移；按分钟取整，避免每次渲染都换查询键
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, Math.floor(Date.now() / 60_000)],
  );
  const { data: previousData } = useUsageSummaryByApp(
    previousRange ?? range,
    { project, model },
    { refetchInterval: false },
  );
  const previous = previousRange
    ? pickSummary(previousData ?? [], appType)
    : undefined;
  const previousCost = parseFiniteNumber(previous?.totalCost) ?? undefined;
  const changeTitle = t("usage.metrics.vsPrevious");

  // No client-side filtering: totals must match the Trend/Logs/Stats below,
  // which all go through the backend's full set of app_types. The
  // KNOWN_APP_TYPES list only governs which filter chips appear.
  const allApps = data ?? [];
  const summary = pickSummary(allApps, appType);

  const cacheWriteState = getCacheWriteAvailability(
    appType ? [appType] : allApps.map((a) => a.appType),
  );

  const input = summary?.totalInputTokens ?? 0;
  const output = summary?.totalOutputTokens ?? 0;
  const cacheWrite = summary?.totalCacheCreationTokens ?? 0;
  const cacheRead = summary?.totalCacheReadTokens ?? 0;
  const realTotal = summary?.realTotalTokens ?? 0;
  const hitRate = summary?.cacheHitRate ?? 0;
  const totalCost = parseFiniteNumber(summary?.totalCost);
  const requests = summary?.totalRequests ?? 0;

  const hitPercent = Math.max(0, Math.min(100, hitRate * 100));
  const hitPercentLabel = hitPercent.toFixed(hitPercent >= 99.95 ? 0 : 1);
  const placeholder = isLoading ? "…" : undefined;

  const cacheWriteHelp =
    cacheWriteState === "na"
      ? t("usage.cacheWriteNotReported")
      : cacheWriteState === "partial"
        ? t("usage.cacheWritePartial")
        : undefined;

  return (
    <section
      aria-label={t("usage.metrics.label")}
      className="flex shrink-0 flex-col gap-2.5"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div
            className={cn(
              "grid gap-2.5",
              compact ? "grid-cols-2" : "grid-cols-4",
            )}
          >
            <MetricCard
              label={t("usage.totalCost")}
              value={
                placeholder ?? (totalCost == null ? "--" : fmtUsd(totalCost, 2))
              }
              title={totalCost == null ? undefined : fmtUsd(totalCost, 6)}
              change={
                previousRange && totalCost != null
                  ? changeRatio(totalCost, previousCost)
                  : null
              }
              changeTitle={
                previousCost != null
                  ? `${changeTitle}: ${fmtUsd(previousCost, 2)}`
                  : changeTitle
              }
            />
            <MetricCard
              label={t("usage.totalRequests")}
              value={placeholder ?? fmtInt(requests, locale)}
              change={
                previousRange
                  ? changeRatio(requests, previous?.totalRequests)
                  : null
              }
              changeTitle={
                previous
                  ? `${changeTitle}: ${fmtInt(previous.totalRequests, locale)}`
                  : changeTitle
              }
            />
            <MetricCard
              label={t("usage.realTotal")}
              help={{
                title: t("usage.metrics.realTotalHelpTitle"),
                body: t("usage.metrics.realTotalHelp"),
              }}
              value={placeholder ?? formatTokensCompact(realTotal, locale)}
              title={fmtInt(realTotal, locale)}
              change={
                previousRange
                  ? changeRatio(realTotal, previous?.realTotalTokens)
                  : null
              }
              changeTitle={
                previous
                  ? `${changeTitle}: ${formatTokensCompact(previous.realTotalTokens, locale)}`
                  : changeTitle
              }
            />
            <MetricCard
              label={t("usage.cacheHitRate")}
              help={{
                title: t("usage.metrics.hitRateHelpTitle"),
                body: t("usage.metrics.hitRateHelp"),
              }}
              value={placeholder ?? `${hitPercentLabel}%`}
            />
          </div>
          {!appType && <AppSplit apps={allApps} locale={locale} />}
          {moreOpen && (
            <div
              className={cn(
                "grid gap-2.5",
                compact ? "grid-cols-2" : "grid-cols-4",
              )}
            >
              <MiniMetric
                label={t("usage.freshInput")}
                value={formatTokensCompact(input, locale)}
                title={fmtInt(input, locale)}
              />
              <MiniMetric
                label={t("usage.output")}
                value={formatTokensCompact(output, locale)}
                title={fmtInt(output, locale)}
              />
              <MiniMetric
                label={t("usage.cacheWrite")}
                value={
                  cacheWriteState === "na"
                    ? "N/A"
                    : formatTokensCompact(cacheWrite, locale)
                }
                title={
                  cacheWriteState === "na" ? undefined : fmtInt(cacheWrite)
                }
                muted={cacheWriteState === "na"}
                help={
                  cacheWriteHelp
                    ? { title: t("usage.cacheWrite"), body: cacheWriteHelp }
                    : undefined
                }
              />
              <MiniMetric
                label={t("usage.cacheRead")}
                value={formatTokensCompact(cacheRead, locale)}
                title={fmtInt(cacheRead, locale)}
              />
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="quiet"
          size="regular"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
          className="shrink-0 gap-1 pe-2 ps-2.5 text-fg-2"
        >
          {t("usage.metrics.more")}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-150",
              moreOpen && "rotate-180",
            )}
          />
        </Button>
      </div>
    </section>
  );
}
