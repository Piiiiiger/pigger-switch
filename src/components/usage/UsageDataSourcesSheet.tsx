import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Loader2 } from "lucide-react";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import { Switch } from "@/components/ui/switch";
import { useAppInfo } from "@/hooks/useSettings";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { KNOWN_APP_TYPES, type AppType } from "@/types/usage";
import { cn } from "@/lib/utils";
import { getResolvedLang, joinNames } from "./format";

interface UsageDataSourcesSheetProps {
  /** 只列这个工具的日志目录；Codex 用量维护只在 Codex 的页里 */
  tool: AppType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionAutoSyncEnabled: boolean;
  onSessionAutoSyncEnabledChange?: (next: boolean) => void;
  /** 「刚刚同步」「N 分钟前同步」；还没手动同步过时为空 */
  syncedLabel?: string;
  syncing: boolean;
  onSyncNow: () => void;
  /** 打开设置（日志目录、从 CC Switch 导入在那里） */
  onOpenSettings?: () => void;
  rebuildingCodex: boolean;
  /** 只负责打开确认框；确认框里写清后果 */
  onRebuildCodex: () => void;
}

function SourceCard({
  title,
  help,
  trailing,
  children,
}: {
  title: string;
  help: { title: string; body: string };
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-panel border border-border px-4 py-3.5">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <h3 className="m-0 truncate text-strong font-semibold text-fg-1">
            {title}
          </h3>
          <HelpTip title={help.title}>{help.body}</HelpTip>
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

/** 一个日志目录：路径 + 找没找到 */
function DirectoryRow({
  label,
  path,
  exists,
}: {
  label: string;
  path?: string;
  exists?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-fg-2">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono" title={path}>
        {path ?? "…"}
      </span>
      {exists != null && (
        <span
          className={cn(
            "shrink-0 rounded-[5px] px-1.5 text-badge leading-5",
            exists
              ? "bg-success-soft text-success-text"
              : "bg-subtle text-fg-2",
          )}
        >
          {exists ? t("usage.sources.found") : t("usage.sources.notFound")}
        </span>
      )}
    </li>
  );
}

/** 「数据来源」抽屉：会话日志扫描、这个工具的日志目录、Codex 用量维护。 */
export function UsageDataSourcesSheet({
  tool,
  open,
  onOpenChange,
  sessionAutoSyncEnabled,
  onSessionAutoSyncEnabledChange,
  syncedLabel,
  syncing,
  onSyncNow,
  onOpenSettings,
  rebuildingCodex,
  onRebuildCodex,
}: UsageDataSourcesSheetProps) {
  const { t, i18n } = useTranslation();
  const { data: info } = useAppInfo();
  const coveredApps = joinNames(
    KNOWN_APP_TYPES.map((app) => APP_DISPLAY_NAME[app]),
    getResolvedLang(i18n),
  );
  const cadence = sessionAutoSyncEnabled
    ? t("usage.sources.cadenceOn")
    : t("usage.sources.cadenceOff");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        width={400}
        closeLabel={t("common.close")}
        dismissOnOutsideClick
      >
        <SheetHeader className="pb-3">
          <SheetTitle>{t("usage.dataSources")}</SheetTitle>
          <SheetDescription className="sr-only">
            {t("usage.dataSources")}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-3 border-t border-border">
          <SourceCard
            title={t("usage.sources.scanTitle")}
            help={{
              title: t("usage.sources.scanHelpTitle"),
              body: t("usage.sources.scanHelp"),
            }}
            trailing={
              <Switch
                checked={sessionAutoSyncEnabled}
                onCheckedChange={(value) =>
                  onSessionAutoSyncEnabledChange?.(value)
                }
                aria-label={t("usage.sources.scanTitle")}
              />
            }
          >
            <ul className="m-0 flex list-none flex-col gap-1 rounded-control bg-subtle px-3 py-2.5 text-caption text-fg-2">
              <li>{t("usage.sources.coverage", { apps: coveredApps })}</li>
              <li>{syncedLabel ? `${cadence} · ${syncedLabel}` : cadence}</li>
            </ul>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="neutral"
                size="compact"
                disabled={syncing}
                onClick={onSyncNow}
              >
                {syncing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t("usage.sessionSync.syncNow")}
              </Button>
            </div>
          </SourceCard>

          <SourceCard
            title={t("usage.sources.dirsTitle")}
            help={{
              title: t("usage.sources.dirsTitle"),
              body: t("usage.sources.dirsHelp"),
            }}
          >
            <ul className="m-0 flex list-none flex-col gap-1.5 rounded-control bg-subtle px-3 py-2.5 text-caption">
              {tool === "claude" ? (
                <DirectoryRow
                  label="Claude Code"
                  path={info?.claudeDir}
                  exists={info?.claudeDirExists}
                />
              ) : (
                <DirectoryRow
                  label="Codex"
                  path={info?.codexDir}
                  exists={info?.codexDirExists}
                />
              )}
            </ul>
            {onOpenSettings && (
              <button
                type="button"
                className="inline-flex w-fit items-center gap-0.5 rounded-[4px] text-body font-medium text-fg-1 underline decoration-border-strong underline-offset-4 hover:decoration-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onOpenChange(false);
                  onOpenSettings();
                }}
              >
                {t("usage.sources.editDirs")}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </SourceCard>

          {tool === "codex" && (
            <SourceCard
              title={t("usage.rebuildCodex.title")}
              help={{
                title: t("usage.sources.codexHelpTitle"),
                body: t("usage.rebuildCodex.description"),
              }}
            >
              <p className="m-0 text-caption text-fg-2">
                {t("usage.rebuildCodex.warning")}
              </p>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="neutral"
                  size="compact"
                  disabled={rebuildingCodex}
                  onClick={onRebuildCodex}
                >
                  {rebuildingCodex && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {t("usage.rebuildCodex.actionEllipsis")}
                </Button>
              </div>
            </SourceCard>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
