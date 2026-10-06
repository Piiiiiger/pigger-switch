import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  ChartColumn,
  Gauge,
  Settings,
  Tags,
  TriangleAlert,
} from "lucide-react";
import { useBudgetStatus, useUsageSummaryByApp } from "@/lib/query/usage";
import { fmtUsd } from "@/components/usage/format";
import { AppGlyph, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE, isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { KNOWN_APP_TYPES, type AppType } from "@/types/usage";
import appLogo from "@/assets/icons/logo.svg";

export type ToolView = "usage" | "limits";
/** Claude Code 和 Codex 各有自己的用量页和额度页，互不混在一起 */
export type ToolPage = `${AppType}.${ToolView}`;
export type Page = ToolPage | "prices" | "settings";

const TOOL_VIEWS: ToolView[] = ["usage", "limits"];

/** 存下的页面名；旧版的 usage / limits 落到 Claude 那一组 */
export function parsePage(value: string | null | undefined): Page | null {
  if (value === "prices" || value === "settings") return value;
  if (value === "usage" || value === "limits") return `claude.${value}`;
  const [tool, view] = (value ?? "").split(".");
  if (
    KNOWN_APP_TYPES.includes(tool as AppType) &&
    TOOL_VIEWS.includes(view as ToolView)
  ) {
    return `${tool as AppType}.${view as ToolView}`;
  }
  return null;
}

/** 页面属于哪个工具；价格和设置是两个工具共用的 */
export function pageTool(page: Page): AppType | null {
  const [tool] = page.split(".");
  return KNOWN_APP_TYPES.includes(tool as AppType) ? (tool as AppType) : null;
}

type IconComponent = ComponentType<{ className?: string }>;

interface SidebarProps {
  page: Page;
  onSelectPage: (page: Page) => void;
}

function NavButton({
  selected,
  icon: Icon,
  label,
  indent = false,
  onClick,
}: {
  selected: boolean;
  icon: IconComponent;
  label: string;
  indent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-control px-2.5 text-start transition-colors hover:bg-subtle",
        indent && "ps-[34px]",
        selected && "bg-selected font-medium hover:bg-selected",
      )}
    >
      <Icon className="h-[16px] w-[16px] shrink-0 text-fg-2" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/** 主导航：Claude Code 一组、Codex 一组（各自的用量和额度），下面是共用的价格和设置。 */
export function Sidebar({ page, onSelectPage }: SidebarProps) {
  const { t } = useTranslation();
  const { data: budget } = useBudgetStatus();
  const { data: today } = useUsageSummaryByApp({ preset: "today" });
  const todayCost = (app: AppType) =>
    today?.find((entry) => entry.appType === app)?.summary.totalCost;

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

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2">
        {KNOWN_APP_TYPES.map((app) => (
          <div
            key={app}
            role="group"
            aria-labelledby={`nav-group-${app}`}
            className="flex flex-col gap-0.5"
          >
            <div className="flex h-8 items-center gap-2 px-2.5">
              <AppGlyph app={app} size={16} />
              <span
                id={`nav-group-${app}`}
                className="min-w-0 flex-1 truncate font-semibold"
              >
                {APP_DISPLAY_NAME[app]}
              </span>
              <span
                className="shrink-0 text-caption tabular-nums text-fg-3"
                title={t("nav.todayCost", { app: APP_DISPLAY_NAME[app] })}
              >
                {today ? fmtUsd(todayCost(app) ?? 0, 2) : ""}
              </span>
            </div>
            {TOOL_VIEWS.map((view) => {
              const target: Page = `${app}.${view}`;
              return (
                <NavButton
                  key={view}
                  indent
                  selected={page === target}
                  icon={view === "usage" ? ChartColumn : Gauge}
                  label={t(`nav.${view}`)}
                  onClick={() => onSelectPage(target)}
                />
              );
            })}
          </div>
        ))}

        <div className="flex flex-col gap-0.5 border-t border-border pt-3">
          <NavButton
            selected={page === "prices"}
            icon={Tags}
            label={t("nav.prices")}
            onClick={() => onSelectPage("prices")}
          />
          <NavButton
            selected={page === "settings"}
            icon={Settings}
            label={t("nav.settings")}
            onClick={() => onSelectPage("settings")}
          />
        </div>
      </div>

      {(overDaily || overMonthly) && (
        <button
          type="button"
          onClick={() => onSelectPage("settings")}
          className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 text-start text-caption font-medium text-danger transition-colors hover:bg-subtle"
        >
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {overDaily ? t("nav.overDailyBudget") : t("nav.overMonthlyBudget")}
        </button>
      )}
    </nav>
  );
}
