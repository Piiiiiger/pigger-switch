import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { ChartColumn, Gauge, Settings } from "lucide-react";
import { useBudgetStatus } from "@/lib/query/usage";
import { fmtUsd } from "@/components/usage/format";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE, isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import appLogo from "@/assets/icons/logo.svg";

export type Page = "usage" | "limits" | "settings";

type IconComponent = ComponentType<{ className?: string }>;

interface SidebarProps {
  page: Page;
  onSelectPage: (page: Page) => void;
}

/** 主导航：品牌 → 三个页面 → 底部今天 / 本月花费。 */
export function Sidebar({ page, onSelectPage }: SidebarProps) {
  const { t } = useTranslation();
  const { data: budget } = useBudgetStatus();

  const items: { page: Page; label: string; icon: IconComponent }[] = [
    { page: "usage", label: t("nav.usage"), icon: ChartColumn },
    { page: "limits", label: t("nav.limits"), icon: Gauge },
    { page: "settings", label: t("nav.settings"), icon: Settings },
  ];

  const overDaily =
    budget?.dailyBudget != null && budget.todayCost >= budget.dailyBudget;
  const overMonthly =
    budget?.monthlyBudget != null && budget.monthCost >= budget.monthlyBudget;

  return (
    <nav
      aria-label={t("nav.mainLabel")}
      className="flex h-full w-[208px] shrink-0 flex-col border-e border-border bg-sidebar text-body text-fg-1"
    >
      <a
        href="#main-content"
        className="absolute -start-[999px] top-2 z-10 rounded-control bg-surface px-2 py-1 text-caption shadow-v7-sm focus:start-2"
      >
        {t("nav.skipToContent")}
      </a>
      {/* macOS 左上角留给红绿灯，品牌往下挪一行 */}
      <div
        className={cn("shrink-0", isMac() ? "h-11" : "h-2")}
        {...DRAG_REGION_ATTR}
        style={DRAG_REGION_STYLE as React.CSSProperties}
      />
      <div
        className="mb-3 flex h-9 shrink-0 items-center gap-2 px-4"
        {...DRAG_REGION_ATTR}
        style={DRAG_REGION_STYLE as React.CSSProperties}
      >
        <img
          src={appLogo}
          alt=""
          draggable={false}
          className="pointer-events-none h-[22px] w-[22px] shrink-0"
        />
        <span className="pointer-events-none min-w-0 truncate text-strong font-semibold">
          Pigger Switch
        </span>
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        {items.map((item) => {
          const Icon = item.icon;
          const selected = page === item.page;
          return (
            <button
              key={item.page}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onSelectPage(item.page)}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-control px-2.5 text-start transition-colors hover:bg-subtle",
                selected && "bg-selected font-medium hover:bg-selected",
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0 text-fg-2" />
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col gap-1 border-t border-border px-4 py-3 text-caption text-fg-2">
        <div className="flex items-center justify-between gap-2">
          <span>{t("nav.today")}</span>
          <span
            className={cn(
              "tabular-nums text-fg-1",
              overDaily && "font-semibold text-danger",
            )}
          >
            {budget ? fmtUsd(budget.todayCost, 2) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span>{t("nav.thisMonth")}</span>
          <span
            className={cn(
              "tabular-nums text-fg-1",
              overMonthly && "font-semibold text-danger",
            )}
          >
            {budget ? fmtUsd(budget.monthCost, 2) : "—"}
          </span>
        </div>
      </div>
    </nav>
  );
}
