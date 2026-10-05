import { Fragment, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useHourlyActivity } from "@/lib/query/usage";
import { cn } from "@/lib/utils";
import type { HourlyActivity, UsageRangeSelection } from "@/types/usage";
import {
  getLocaleFromLanguage,
  getResolvedLang,
  parseFiniteNumber,
} from "./format";
import { UsageTooltipCard } from "./UsageTooltipCard";
import { usageTable } from "./usageTable";

type Metric = "tokens" | "requests" | "cost";

interface ActivityHeatmapProps {
  range: UsageRangeSelection;
  appType?: string;
  project?: string;
  model?: string;
  refreshIntervalMs: number;
}

interface Cell {
  weekday: number;
  hour: number;
  tokens: number;
  requests: number;
  cost: number;
}

const LEVELS = [0, 1, 2, 3, 4];

function valueOf(cell: Cell, metric: Metric) {
  return metric === "tokens"
    ? cell.tokens
    : metric === "requests"
      ? cell.requests
      : cell.cost;
}

/** 按非零格子的四分位分档（同年度热力图） */
function thresholdsOf(values: number[]) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [Infinity, Infinity, Infinity];
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return [at(0.25), at(0.5), at(0.75)];
}

function levelOf(value: number, thresholds: number[]) {
  if (value <= 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

/**
 * 一周里哪几个钟头用得最多（星期 × 小时，本地时间）。只来自明细：
 * 30 天前的数据已经按天汇总，没有小时。
 */
export function ActivityHeatmap({
  range,
  appType,
  project,
  model,
  refreshIntervalMs,
}: ActivityHeatmapProps) {
  const { t, i18n } = useTranslation();
  const locale = getLocaleFromLanguage(getResolvedLang(i18n));
  const [metric, setMetric] = useState<Metric>("cost");
  const sectionRef = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<{
    cell: Cell;
    x: number;
    y: number;
  } | null>(null);
  const { data, isLoading } = useHourlyActivity(
    range,
    { appType, project, model },
    { refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false },
  );

  const grid = useMemo(() => {
    const cells: Cell[][] = Array.from({ length: 7 }, (_, weekday) =>
      Array.from({ length: 24 }, (_, hour) => ({
        weekday,
        hour,
        tokens: 0,
        requests: 0,
        cost: 0,
      })),
    );
    for (const row of (data ?? []) as HourlyActivity[]) {
      const cell = cells[row.weekday]?.[row.hour];
      if (!cell) continue;
      cell.tokens = row.totalTokens;
      cell.requests = row.requestCount;
      cell.cost = parseFiniteNumber(row.totalCost) ?? 0;
    }
    const flat = cells.flat();
    const thresholds = thresholdsOf(flat.map((c) => valueOf(c, metric)));
    // 最忙的钟头（按当前指标）
    const busiest = flat.reduce<Cell | null>(
      (best, c) =>
        valueOf(c, metric) > (best ? valueOf(best, metric) : 0) ? c : best,
      null,
    );
    const hourTotals = Array.from({ length: 24 }, (_, hour) =>
      cells.reduce((sum, day) => sum + valueOf(day[hour], metric), 0),
    );
    return { cells, thresholds, busiest, hourTotals };
  }, [data, metric]);

  const weekdayLabels = useMemo(
    () =>
      Array.from({ length: 7 }, (_, d) =>
        // 2024-01-01 是周一
        new Date(2024, 0, 1 + d).toLocaleDateString(locale, {
          weekday: "short",
        }),
      ),
    [locale],
  );

  if (isLoading) {
    return <div className={usageTable.skeleton} />;
  }

  const showTooltip = (cell: Cell, target: HTMLElement) => {
    const section = sectionRef.current;
    if (!section) return;
    const box = section.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    setHover({
      cell,
      x: rect.left + rect.width / 2 - box.left,
      y: rect.top - box.top,
    });
  };

  const busiest = grid.busiest;
  const maxHour = Math.max(0, ...grid.hourTotals);

  return (
    <section ref={sectionRef} className="relative flex flex-col gap-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="m-0 text-caption text-fg-3">
          {busiest
            ? t("usage.activity.busiest", {
                day: weekdayLabels[busiest.weekday],
                hour: `${String(busiest.hour).padStart(2, "0")}:00`,
              })
            : t("usage.noData")}
          {" · "}
          {t("usage.activity.detailOnly")}
        </p>
        <div className="flex-1" />
        <SegmentedControl<Metric>
          size="sm"
          aria-label={t("usage.trend.metricLabel")}
          value={metric}
          onValueChange={setMetric}
          items={[
            { value: "cost", label: t("usage.trend.cost") },
            { value: "tokens", label: t("usage.trend.tokens") },
            { value: "requests", label: t("usage.trend.requests") },
          ]}
        />
      </div>

      <div
        className="grid items-center gap-[3px]"
        style={{
          gridTemplateColumns: "max-content repeat(24, minmax(0, 1fr))",
        }}
      >
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span
            key={`h${hour}`}
            className="text-center text-badge leading-4 text-fg-3"
          >
            {hour % 3 === 0 ? hour : ""}
          </span>
        ))}
        {grid.cells.map((day, weekday) => (
          <Fragment key={`d${weekday}`}>
            <span className="pe-2 text-badge leading-none text-fg-3">
              {weekdayLabels[weekday]}
            </span>
            {day.map((cell) => {
              const level = levelOf(valueOf(cell, metric), grid.thresholds);
              return (
                <div
                  key={`${weekday}-${cell.hour}`}
                  onMouseEnter={(event) =>
                    showTooltip(cell, event.currentTarget)
                  }
                  onMouseLeave={() => setHover(null)}
                  className={cn(
                    "h-5 rounded-[3px]",
                    level === 0 && "bg-subtle",
                  )}
                  style={
                    level === 0
                      ? undefined
                      : { backgroundColor: `var(--heat-${level})` }
                  }
                />
              );
            })}
          </Fragment>
        ))}
        {/* 每个钟头的合计，柱子越高越忙 */}
        <span />
        {grid.hourTotals.map((total, hour) => (
          <div key={`t${hour}`} className="flex h-8 items-end">
            <div
              className="w-full rounded-t-[2px] bg-[var(--heat-3)]"
              style={{
                height:
                  maxHour > 0 ? `${Math.max(4, (total / maxHour) * 100)}%` : 0,
                opacity: total > 0 ? 1 : 0,
              }}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-1.5 text-badge text-fg-3">
        {t("usage.heatmap.less")}
        {LEVELS.map((level) => (
          <span
            key={level}
            className={cn(
              "h-2.5 w-2.5 rounded-[2px]",
              level === 0 && "bg-subtle",
            )}
            style={
              level === 0
                ? undefined
                : { backgroundColor: `var(--heat-${level})` }
            }
          />
        ))}
        {t("usage.heatmap.more")}
      </div>

      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20"
          style={{
            left: hover.x,
            top: hover.y - 8,
            transform: `translate(${
              hover.x < 110
                ? "-15%"
                : hover.x > (sectionRef.current?.clientWidth ?? 0) - 110
                  ? "-85%"
                  : "-50%"
            }, -100%)`,
          }}
        >
          <UsageTooltipCard
            heading={`${weekdayLabels[hover.cell.weekday]} ${String(hover.cell.hour).padStart(2, "0")}:00–${String(hover.cell.hour + 1).padStart(2, "0")}:00`}
            tokens={hover.cell.tokens}
            requests={hover.cell.requests}
            cost={hover.cell.cost}
          />
        </div>
      )}
    </section>
  );
}
