import { useTranslation } from "react-i18next";
import { fmtUsd, formatTokensCompact } from "@/components/usage/format";
import { cn } from "@/lib/utils";
import type { CurrentWindow } from "@/types/subscription";
import {
  SegmentedBar,
  formatCountdown,
  formatWindowSpan,
  tierLabel,
  tierTone,
} from "./quota";

const TONE_TEXT = {
  normal: "",
  warning: "text-warning-text",
  danger: "text-danger-text",
} as const;

function Row({
  label,
  value,
  detail,
  strong = false,
}: {
  label: string;
  value: string;
  /** 第二行的小字（估算的范围、依据）；没有时也占位，几张卡的行对齐 */
  detail?: string;
  strong?: boolean;
}) {
  return (
    <>
      <dt className="text-fg-2">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-col items-end text-end">
        <span
          className={cn("tabular-nums text-fg-1", strong && "font-semibold")}
        >
          {value}
        </span>
        {detail !== undefined && (
          <span className="text-badge font-normal tabular-nums text-fg-3">
            {detail || "\u00a0"}
          </span>
        )}
      </dd>
    </>
  );
}

/**
 * 一个额度窗口：接口给的百分比，本机在这个窗口里的用量，估出的总额度和剩余，
 * 照现在的速度会怎样。几张卡并排时行数一样、页脚两行，高度和分区都对齐。
 */
export function WindowCard({
  window: w,
  locale,
  now,
}: {
  window: CurrentWindow;
  locale: string;
  /** 毫秒 */
  now: number;
}) {
  const { t } = useTranslation();
  const label = tierLabel(t, w.tier);
  const limit = w.limit;
  const shown = w.estimatedUtilization ?? w.reportedUtilization ?? 0;
  const tone = tierTone(Math.max(shown, w.reportedUtilization ?? 0));
  const usd = (value: number) => fmtUsd(value, 2);
  const tokens = (value: number) =>
    t("limits.window.tokens", { value: formatTokensCompact(value, locale) });
  const timeOf = (unix: number) =>
    new Date(unix * 1000).toLocaleString(locale, {
      weekday:
        w.end != null && w.start != null && w.end - w.start > 86_400
          ? "short"
          : undefined,
      hour: "numeric",
      minute: "2-digit",
    });
  const resetIso = w.end != null ? new Date(w.end * 1000).toISOString() : null;
  const countdown = formatCountdown(resetIso, now);
  const showEstimateNow =
    w.reportedUtilization != null &&
    w.estimatedUtilization != null &&
    Math.abs(w.estimatedUtilization - w.reportedUtilization) >= 1;

  const limitDetail = !limit
    ? ""
    : limit.basis === "typical"
      ? t("limits.window.basisTypical", {
          count: limit.windows,
          low: usd(limit.costLow),
          high: usd(limit.costHigh),
        })
      : t("limits.window.basisCurrent", {
          low: usd(limit.costLow),
          high: usd(limit.costHigh),
        });

  let pace: { text: string; warn: boolean };
  if (!limit) {
    // 本机在这个窗口里一个请求都没有，百分比却不是 0：额度是在别处用掉的
    const elsewhere = w.used.requests === 0 && (w.reportedUtilization ?? 0) > 0;
    pace = {
      text:
        w.start == null
          ? t("limits.window.noResetTime")
          : elsewhere
            ? t("limits.window.usedElsewhere")
            : t("limits.window.noEstimate"),
      warn: false,
    };
  } else if (w.remainingCostUsd != null && w.remainingCostUsd <= 0) {
    pace = { text: t("limits.window.usedUp"), warn: true };
  } else if (w.exhaustsAt != null) {
    pace = {
      text: t("limits.window.runsOutAt", { time: timeOf(w.exhaustsAt) }),
      warn: true,
    };
  } else if (w.projectedUtilization != null) {
    pace = {
      text: t("limits.window.projected", {
        value: Math.round(w.projectedUtilization),
      }),
      warn: false,
    };
  } else {
    pace = { text: "\u00a0", warn: false };
  }
  // 用完了就不再平分
  const budget =
    w.perFiveHourCostUsd != null &&
    w.fiveHourWindowsLeft != null &&
    (w.remainingCostUsd ?? 0) > 0
      ? t("limits.window.perFiveHour", {
          count: w.fiveHourWindowsLeft,
          cost: usd(w.perFiveHourCostUsd),
          tokens: formatTokensCompact(w.perFiveHourTokens ?? 0, locale),
        })
      : null;

  return (
    <section
      aria-label={label}
      className="flex h-full min-w-0 flex-col rounded-panel border border-border bg-surface"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <h3 className="m-0 truncate text-body font-semibold">{label}</h3>
        <span className="flex-1" />
        <span className="truncate text-caption tabular-nums text-fg-3">
          {w.start != null && w.end != null
            ? formatWindowSpan(w.start, w.end, locale)
            : "\u00a0"}
        </span>
      </header>

      <div className="flex flex-1 flex-col gap-3 px-4 py-3.5">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-[26px] font-semibold leading-none tabular-nums",
              TONE_TEXT[tone],
            )}
          >
            {Math.round(w.reportedUtilization ?? shown)}%
          </span>
          <span className="text-caption text-fg-2">
            {w.reportedUtilization != null
              ? t("limits.window.reported")
              : t("limits.window.estimated")}
          </span>
          <span className="ms-auto text-caption tabular-nums text-fg-2">
            {showEstimateNow
              ? t("limits.window.nowAbout", {
                  value: Math.round(w.estimatedUtilization!),
                })
              : "\u00a0"}
          </span>
        </div>
        <SegmentedBar utilization={shown} />
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 text-body">
          <Row
            label={t("limits.window.used")}
            value={`${usd(w.used.costUsd)} · ${tokens(w.used.totalTokens)}`}
            detail={t("limits.window.requests", { count: w.used.requests })}
          />
          <Row
            label={t("limits.window.limit")}
            value={
              limit ? `≈ ${usd(limit.costUsd)} · ${tokens(limit.tokens)}` : "—"
            }
            detail={limitDetail}
          />
          <Row
            label={t("limits.window.remaining")}
            value={
              w.remainingCostUsd != null
                ? `≈ ${usd(w.remainingCostUsd)} · ${tokens(w.remainingTokens ?? 0)}`
                : "—"
            }
            strong
          />
          <Row
            label={t("limits.window.resets")}
            value={
              countdown && w.end != null
                ? t("limits.window.resetsIn", {
                    countdown,
                    time: timeOf(w.end),
                  })
                : t("limits.resetUnknown")
            }
          />
        </dl>
      </div>

      <footer className="flex shrink-0 flex-col gap-0.5 border-t border-border px-4 py-2.5 text-caption">
        <span
          className={cn(
            "truncate",
            pace.warn ? "font-medium text-warning-text" : "text-fg-2",
          )}
          title={pace.text}
        >
          {pace.text}
        </span>
        <span className="truncate text-fg-3" title={budget ?? undefined}>
          {budget ?? "\u00a0"}
        </span>
      </footer>
    </section>
  );
}
