import { useTranslation } from "react-i18next";
import { useSessionStats } from "@/lib/query/usage";
import { AppGlyph } from "@/components/shell/AppGlyph";
import { TablePagination, useClientPagination } from "./TablePagination";
import { cn } from "@/lib/utils";
import {
  fmtInt,
  fmtUsd,
  formatRelativeTime,
  formatTokensCompact,
  getLocaleFromLanguage,
  getResolvedLang,
} from "./format";
import { usageTable } from "./usageTable";
import { projectLabel, shortenHome } from "./project";
import type { SessionStats, UsageRangeSelection } from "@/types/usage";

interface SessionStatsTableProps {
  range: UsageRangeSelection;
  appType?: string;
  project?: string;
  model?: string;
  refreshIntervalMs: number;
  /** 点一行：看这个会话的每一条请求 */
  onOpenSession?: (session: SessionStats) => void;
}

/** 会话的展示名：Claude Code 起的标题；没有标题时用会话 ID 前 8 位 */
export function sessionLabel(
  session: Pick<SessionStats, "title" | "sessionId">,
) {
  return session.title?.trim() || session.sessionId.slice(0, 8);
}

/** 「12 分钟」「2 小时 5 分」：会话从第一条到最后一条请求的时长 */
function formatDuration(seconds: number, lang: string) {
  const minutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const zh = lang.startsWith("zh");
  const ja = lang.startsWith("ja");
  if (hours === 0)
    return zh ? `${minutes} 分钟` : ja ? `${minutes} 分` : `${minutes}m`;
  if (zh) return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  if (ja) return rest ? `${hours} 時間 ${rest} 分` : `${hours} 時間`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** 按会话汇总（花费从高到低）。只有最近 30 天的明细带会话维度。 */
export function SessionStatsTable({
  range,
  appType,
  project,
  model,
  refreshIntervalMs,
  onOpenSession,
}: SessionStatsTableProps) {
  const { t, i18n } = useTranslation();
  const lang = getResolvedLang(i18n);
  const locale = getLocaleFromLanguage(lang);
  const { data: stats, isLoading } = useSessionStats(
    range,
    { appType, project, model },
    { refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false },
  );
  const rows = stats ?? [];
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
          className={cn(usageTable.table, "min-w-[760px]")}
          aria-label={t("usage.sessionStats")}
        >
          <thead>
            <tr className={usageTable.headRow}>
              <th className={usageTable.th}>{t("usage.session")}</th>
              <th className={usageTable.th}>{t("usage.project")}</th>
              <th className={usageTable.th}>{t("usage.model")}</th>
              <th className={usageTable.thEnd}>{t("usage.requests")}</th>
              <th className={usageTable.thEnd}>{t("usage.tokens")}</th>
              <th className={usageTable.thEnd}>{t("usage.totalCost")}</th>
              <th className={usageTable.thEnd}>{t("usage.lastActive")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className={usageTable.empty}>
                  {t("usage.noData")}
                </td>
              </tr>
            ) : (
              pagination.pageRows.map((session) => {
                const app = session.appType === "codex" ? "codex" : "claude";
                const label = sessionLabel(session);
                const duration = session.lastAt - session.firstAt;
                return (
                  <tr
                    key={`${session.appType}:${session.sessionId}`}
                    className={
                      onOpenSession ? usageTable.rowInteractive : usageTable.row
                    }
                    onClick={() => onOpenSession?.(session)}
                  >
                    <td className={cn(usageTable.td, "w-[30%] max-w-0")}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <AppGlyph app={app} size={14} />
                        <span
                          className={cn(
                            "truncate",
                            !session.title && "font-mono text-caption",
                          )}
                          title={`${label}\n${session.sessionId}`}
                        >
                          {label}
                        </span>
                      </span>
                    </td>
                    <td className={cn(usageTable.td, "w-[16%] max-w-0")}>
                      <span
                        className={cn(
                          "block truncate",
                          !session.project && usageTable.muted,
                        )}
                        title={
                          session.project
                            ? shortenHome(session.project)
                            : undefined
                        }
                      >
                        {projectLabel(session.project, t)}
                      </span>
                    </td>
                    <td
                      className={cn(
                        usageTable.td,
                        usageTable.mono,
                        "w-[16%] max-w-0",
                      )}
                    >
                      <span className="block truncate" title={session.model}>
                        {session.model}
                      </span>
                    </td>
                    <td className={usageTable.tdEnd}>
                      {fmtInt(session.requestCount, locale)}
                    </td>
                    <td
                      className={usageTable.tdEnd}
                      title={t("usage.cacheReadTip", {
                        value: fmtInt(session.cacheReadTokens, locale),
                      })}
                    >
                      {formatTokensCompact(session.totalTokens, locale)}
                    </td>
                    <td
                      className={cn(usageTable.tdEnd, "font-medium")}
                      title={fmtUsd(session.totalCost, 6)}
                    >
                      {fmtUsd(session.totalCost, 2)}
                    </td>
                    <td
                      className={cn(usageTable.tdEnd, "text-fg-2")}
                      title={`${new Date(session.firstAt * 1000).toLocaleString(locale)} → ${new Date(session.lastAt * 1000).toLocaleString(locale)} (${formatDuration(duration, lang)})`}
                    >
                      {formatRelativeTime(session.lastAt * 1000, t, now)}
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
