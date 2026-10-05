import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStats } from "@/lib/query/usage";
import { APP_COLOR } from "@/components/shell/AppGlyph";
import { TablePagination, useClientPagination } from "./TablePagination";
import { cn } from "@/lib/utils";
import {
  fmtInt,
  fmtUsd,
  formatRelativeTime,
  formatTokensCompact,
  getLocaleFromLanguage,
  getResolvedLang,
  parseFiniteNumber,
} from "./format";
import { usageTable } from "./usageTable";
import { projectLabel, shortenHome } from "./project";
import type { UsageRangeSelection } from "@/types/usage";

interface ProjectStatsTableProps {
  range: UsageRangeSelection;
  appType?: string;
  project?: string;
  model?: string;
  refreshIntervalMs: number;
  /** 点一行：把整个面板筛到这个项目 */
  onSelectProject?: (project: string) => void;
}

/** 按项目（会话所在的工作目录）汇总；花费那一列画出 Claude / Codex 的占比 */
export function ProjectStatsTable({
  range,
  appType,
  project,
  model,
  refreshIntervalMs,
  onSelectProject,
}: ProjectStatsTableProps) {
  const { t, i18n } = useTranslation();
  const locale = getLocaleFromLanguage(getResolvedLang(i18n));
  const { data: stats, isLoading } = useProjectStats(
    range,
    { appType, project, model },
    { refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false },
  );

  const rows = stats ?? [];
  const maxCost = useMemo(
    () => Math.max(0, ...rows.map((s) => parseFiniteNumber(s.totalCost) ?? 0)),
    [rows],
  );
  const pagination = useClientPagination(
    rows,
    JSON.stringify([range, appType, project, model]),
  );
  const now = Date.now();

  if (isLoading) {
    return <div className={usageTable.skeleton} />;
  }

  return (
    <div className="flex flex-col">
      <div className={usageTable.scroller}>
        <table
          className={cn(usageTable.table, "min-w-[640px]")}
          aria-label={t("usage.projectStats")}
        >
          <thead>
            <tr className={usageTable.headRow}>
              <th className={usageTable.th}>{t("usage.project")}</th>
              <th className={usageTable.thEnd}>{t("usage.requests")}</th>
              <th className={usageTable.thEnd}>{t("usage.sessions")}</th>
              <th className={usageTable.thEnd}>{t("usage.tokens")}</th>
              <th className={cn(usageTable.th, "w-[28%]")}>
                {t("usage.totalCost")}
              </th>
              <th className={usageTable.thEnd}>{t("usage.lastActive")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className={usageTable.empty}>
                  {t("usage.noData")}
                </td>
              </tr>
            ) : (
              pagination.pageRows.map((stat) => {
                const total = parseFiniteNumber(stat.totalCost) ?? 0;
                const claude = parseFiniteNumber(stat.claudeCost) ?? 0;
                const codex = parseFiniteNumber(stat.codexCost) ?? 0;
                const width = maxCost > 0 ? (total / maxCost) * 100 : 0;
                const name = projectLabel(stat.project, t);
                return (
                  <tr
                    key={stat.project || "__unknown"}
                    className={
                      onSelectProject && stat.project
                        ? usageTable.rowInteractive
                        : usageTable.row
                    }
                    onClick={() => {
                      if (stat.project) onSelectProject?.(stat.project);
                    }}
                  >
                    <td className={cn(usageTable.td, "max-w-0")}>
                      <span
                        className={cn(
                          "block truncate",
                          !stat.project && usageTable.muted,
                        )}
                        title={
                          stat.project ? shortenHome(stat.project) : undefined
                        }
                      >
                        {name}
                      </span>
                    </td>
                    <td className={usageTable.tdEnd}>
                      {fmtInt(stat.requestCount, locale)}
                    </td>
                    <td
                      className={cn(
                        usageTable.tdEnd,
                        stat.sessionCount === 0 && usageTable.muted,
                      )}
                    >
                      {stat.sessionCount > 0
                        ? fmtInt(stat.sessionCount, locale)
                        : "—"}
                    </td>
                    <td
                      className={usageTable.tdEnd}
                      title={fmtInt(stat.totalTokens, locale)}
                    >
                      {formatTokensCompact(stat.totalTokens, locale)}
                    </td>
                    <td className={usageTable.td}>
                      <div
                        className="flex items-center gap-2"
                        title={`Claude ${fmtUsd(claude, 2)} · Codex ${fmtUsd(codex, 2)}`}
                      >
                        <span className="w-[72px] shrink-0 text-end font-medium tabular-nums">
                          {fmtUsd(total, 2)}
                        </span>
                        <span className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-subtle">
                          <span
                            className="flex h-full overflow-hidden rounded-full"
                            style={{ width: `${width}%` }}
                          >
                            <span
                              className="h-full"
                              style={{
                                width:
                                  total > 0 ? `${(claude / total) * 100}%` : 0,
                                background: APP_COLOR.claude,
                              }}
                            />
                            <span
                              className="h-full"
                              style={{
                                width:
                                  total > 0 ? `${(codex / total) * 100}%` : 0,
                                background: APP_COLOR.codex,
                              }}
                            />
                          </span>
                        </span>
                      </div>
                    </td>
                    <td
                      className={cn(usageTable.tdEnd, "text-fg-2")}
                      title={
                        stat.lastActiveAt > 0
                          ? new Date(stat.lastActiveAt * 1000).toLocaleString(
                              locale,
                            )
                          : undefined
                      }
                    >
                      {stat.lastActiveAt > 0
                        ? formatRelativeTime(stat.lastActiveAt * 1000, t, now)
                        : "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <TablePagination
        page={pagination.page}
        totalPages={pagination.totalPages}
        total={pagination.total}
        onPageChange={pagination.setPage}
      />
    </div>
  );
}
