import { useTranslation } from "react-i18next";
import { BellRing, Gauge } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/useSettings";
import { QuotaCard } from "./QuotaCard";

interface LimitsPageProps {
  onOpenSettings?: () => void;
}

/**
 * 订阅额度页：Claude（Pro / Max）和 Codex（ChatGPT 方案）各一张卡，
 * 读的是 CLI 自己的登录凭据，只查询、不改动任何东西。
 */
export function LimitsPage({ onOpenSettings }: LimitsPageProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const alert = settings?.quotaAlertPercent;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<Gauge className="h-5 w-5" strokeWidth={1.5} />}
        title={t("limits.title")}
      />
      <div
        id="main-content"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto scroll-stable px-6 py-5"
      >
        <p className="m-0 max-w-[720px] text-body text-fg-2">
          {t("limits.subtitle")}
        </p>
        <div className="grid grid-cols-1 gap-4 min-[860px]:grid-cols-2">
          <QuotaCard tool="claude" />
          <QuotaCard tool="codex" />
        </div>
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
