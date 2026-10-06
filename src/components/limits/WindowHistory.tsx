import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { fmtInt, fmtUsd, formatTokensCompact } from "@/components/usage/format";
import { usageTable } from "@/components/usage/usageTable";
import { cn } from "@/lib/utils";
import type { PastWindow, QuotaWindowsReport } from "@/types/subscription";
import { formatWindowSpan } from "./quota";

type HistoryKind = "fiveHour" | "weekly";

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * 过去的 5 小时 / 每周窗口：每个窗口本机用了多少、接口给过的最高百分比、
 * 用它估出的总额度。没有读数的窗口按典型额度折算出大约用了几成。
 */
export function WindowHistory({
  report,
  locale,
}: {
  report: QuotaWindowsReport;
  locale: string;
}) {
  const { t } = useTranslation();
  const lists: Record<HistoryKind, PastWindow[]> = {
    fiveHour: report.fiveHourHistory,
    weekly: report.weeklyHistory,
  };
  const kinds = (["fiveHour", "weekly"] as const).filter(
    (kind) => lists[kind].length > 0,
  );
  const [picked, setPicked] = useState<HistoryKind>("fiveHour");
  const kind = kinds.includes(picked) ? picked : kinds[0];
  const rows = kind ? lists[kind] : [];
  // 有读数的窗口估出的额度取中位数，给没有读数的窗口折算用了几成
  const typical = useMemo(
    () => median(rows.flatMap((w) => (w.limit ? [w.limit.costUsd] : []))),
    [rows],
  );

  return (
    <section
      aria-labelledby="window-history-title"
      className="flex flex-col gap-2"
    >
      <div className="flex min-h-8 flex-wrap items-center gap-3">
        <h2 id="window-history-title" className="m-0 text-section">
          {t("limits.history.title")}
        </h2>
        <span className="flex-1" />
        {kinds.length > 1 && kind && (
          <SegmentedControl<HistoryKind>
            size="sm"
            aria-label={t("limits.history.title")}
            value={kind}
            onValueChange={setPicked}
            items={kinds.map((value) => ({
              value,
              label: t(`limits.history.${value}`),
            }))}
          />
        )}
      </div>
      {!kind ? (
        <p className={usageTable.empty}>{t("limits.history.empty")}</p>
      ) : (
        <>
          <div className={usageTable.scroller}>
            <table className={usageTable.table}>
              <thead>
                <tr className={usageTable.headRow}>
                  <th className={usageTable.th}>
                    {t("limits.history.window")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("limits.history.requests")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("limits.history.tokens")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("limits.history.cost")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("limits.history.share")}
                  </th>
                  <th className={usageTable.thEnd}>
                    {t("limits.history.limit")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const estimatedShare =
                    w.peakUtilization == null && typical
                      ? (w.used.costUsd / typical) * 100
                      : null;
                  return (
                    <tr
                      key={`${w.start}-${w.end}`}
                      className={cn(usageTable.row, w.current && "bg-subtle")}
                    >
                      <td className={usageTable.td}>
                        <span className="inline-flex items-center gap-1.5">
                          {formatWindowSpan(w.start, w.end, locale)}
                          {!w.exact && (
                            <span
                              className="text-fg-3"
                              title={t("limits.history.inferredHint")}
                            >
                              *
                            </span>
                          )}
                          {w.current && (
                            <span className="rounded-[5px] bg-selected px-1.5 text-badge leading-5 text-fg-1">
                              {t("limits.history.now")}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={usageTable.tdEnd}>
                        {fmtInt(w.used.requests, locale)}
                      </td>
                      <td className={usageTable.tdEnd}>
                        {formatTokensCompact(w.used.totalTokens, locale)}
                      </td>
                      <td className={usageTable.tdEnd}>
                        {fmtUsd(w.used.costUsd, 2)}
                      </td>
                      <td
                        className={cn(
                          usageTable.tdEnd,
                          estimatedShare != null && usageTable.muted,
                        )}
                        title={
                          estimatedShare != null
                            ? t("limits.history.shareEstimated")
                            : undefined
                        }
                      >
                        {w.peakUtilization != null
                          ? `${Math.round(w.peakUtilization)}%`
                          : estimatedShare != null
                            ? `≈ ${Math.round(estimatedShare)}%`
                            : "—"}
                      </td>
                      <td className={usageTable.tdEnd}>
                        {w.limit ? `≈ ${fmtUsd(w.limit.costUsd, 2)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="m-0 text-caption text-fg-3">
            {t("limits.history.footnote")}
          </p>
        </>
      )}
    </section>
  );
}
