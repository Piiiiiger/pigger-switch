import { useTranslation } from "react-i18next";
import { BellRing, Loader2, RefreshCw } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { AppGlyph, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { Button } from "@/components/ui/button";
import { getLocaleFromLanguage } from "@/components/usage/format";
import { useSettings } from "@/hooks/useSettings";
import {
  useQuotaWindows,
  useSubscriptionQuota,
} from "@/lib/query/subscription";
import type { QuotaTool } from "@/types/subscription";
import { WindowCard } from "./WindowCard";
import { WindowHistory } from "./WindowHistory";
import { quotaProblem, sortWindows, useNow, useRefreshQuota } from "./quota";

interface LimitsPageProps {
  tool: QuotaTool;
  onOpenSettings?: () => void;
}

/**
 * 一个工具的订阅额度：每个窗口用了多少、估出的实际额度和剩余、照现在的速度
 * 会怎样，以及过去每个 5 小时 / 每周窗口。只读 CLI 自己的登录，不改动任何东西。
 */
export function LimitsPage({ tool, onOpenSettings }: LimitsPageProps) {
  const { t, i18n } = useTranslation();
  const { settings } = useSettings();
  const { data: quota, isLoading, error } = useSubscriptionQuota(tool);
  const { data: report } = useQuotaWindows(tool);
  const { refresh, refreshing } = useRefreshQuota(tool);
  const now = useNow();
  const locale = getLocaleFromLanguage(
    i18n.resolvedLanguage || i18n.language || "en",
  );
  const problem = quotaProblem(t, tool, quota, error);
  const windows = quota?.success ? sortWindows(report?.windows ?? []) : [];
  const alert = settings?.quotaAlertPercent;
  const extraUsage = quota?.success ? quota.extraUsage : null;
  const savedResets = quota?.success
    ? (quota.resetCredits?.expiresAt.length ?? 0)
    : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        variant="app"
        icon={<AppGlyph app={tool} size={20} />}
        title={APP_DISPLAY_NAME[tool]}
        subtitle={t("nav.limits")}
        titleExtra={
          quota?.plan && (
            <span
              className="ms-1 rounded-[5px] bg-subtle px-1.5 text-badge leading-5 text-fg-1"
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
          )
        }
        actions={
          <>
            {quota?.queriedAt != null && (
              <span className="text-caption tabular-nums text-fg-3">
                {t("limits.readAt", {
                  time: new Date(quota.queriedAt).toLocaleTimeString(locale, {
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                })}
              </span>
            )}
            <Button
              type="button"
              variant="neutral"
              size="regular"
              className="gap-1.5 ps-2.5"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t("limits.refresh")}
            </Button>
          </>
        }
      />
      <div
        id="main-content"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto scroll-stable px-6 py-5"
      >
        <p className="m-0 max-w-[760px] text-body text-fg-2">
          {t(`limits.intro.${tool}`)}
        </p>

        {isLoading ? (
          <div className="flex h-[200px] items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
          </div>
        ) : problem ? (
          <p className="m-0 rounded-panel border border-border bg-surface px-4 py-3.5 text-body text-fg-2">
            {problem}
          </p>
        ) : windows.length === 0 ? (
          <p className="m-0 rounded-panel border border-border bg-surface px-4 py-3.5 text-body text-fg-2">
            {t("limits.noWindows")}
          </p>
        ) : (
          <div className="grid auto-rows-fr grid-cols-1 gap-4 min-[1040px]:grid-cols-2">
            {windows.map((w) => (
              <WindowCard key={w.tier} window={w} locale={locale} now={now} />
            ))}
          </div>
        )}

        {(extraUsage?.isEnabled || savedResets > 0) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-caption tabular-nums text-fg-2">
            {extraUsage?.isEnabled && (
              <span>
                {t("limits.extraUsage", {
                  used: (extraUsage.usedCredits ?? 0).toFixed(2),
                  limit:
                    extraUsage.monthlyLimit != null
                      ? extraUsage.monthlyLimit.toFixed(2)
                      : "∞",
                  currency: extraUsage.currency ?? "USD",
                })}
              </span>
            )}
            {savedResets > 0 && (
              <span>{t("limits.resetCredits", { count: savedResets })}</span>
            )}
          </div>
        )}

        {windows.length > 0 && (
          <p className="m-0 max-w-[760px] text-caption text-fg-3">
            {t(`limits.estimateNote.${tool}`)}
          </p>
        )}

        {report && <WindowHistory report={report} locale={locale} />}

        <div className="flex flex-wrap items-center gap-3 rounded-panel bg-subtle px-4 py-3 text-body text-fg-2">
          <BellRing className="h-4 w-4 shrink-0 text-fg-2" />
          <span className="min-w-0 flex-1">
            {alert
              ? t("limits.alertOn", { percent: alert })
              : t("limits.alertOff")}
          </span>
          {onOpenSettings && (
            <Button
              type="button"
              variant="neutral"
              size="compact"
              onClick={onOpenSettings}
            >
              {t("limits.alertConfigure")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
