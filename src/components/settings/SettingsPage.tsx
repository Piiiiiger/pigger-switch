import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2, RotateCcw, Settings } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/components/theme-provider";
import { settingsKeys, useAppInfo, useSettings } from "@/hooks/useSettings";
import {
  settingsApi,
  type AppSettings,
  type LanguageCode,
} from "@/lib/api/settings";
import { usageKeys } from "@/lib/query/usage";
import { toast } from "@/lib/toast";
import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="m-0 text-section">{title}</h2>
        {description && (
          <p className="m-0 text-caption text-fg-3">{description}</p>
        )}
      </div>
      <div className="flex flex-col rounded-panel border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  description,
  children,
  stacked = false,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  /** 控件放到说明下面（路径输入框这类宽控件） */
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-4 border-b border-border px-4 py-3 last:border-b-0",
        stacked ? "flex-col gap-2" : "items-center justify-between",
      )}
    >
      <div className="min-w-0">
        <div className="text-body font-medium">{label}</div>
        {description && (
          <div className="text-caption text-fg-3">{description}</div>
        )}
      </div>
      <div className={cn(stacked ? "w-full" : "shrink-0")}>{children}</div>
    </div>
  );
}

/** 失焦或回车才提交的输入框（数字、路径、代理地址） */
function CommitInput({
  value,
  onCommit,
  placeholder,
  className,
  inputMode,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  className?: string;
  inputMode?: "decimal" | "text";
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value.trim()) onCommit(draft.trim());
  };
  return (
    <Input
      value={draft}
      placeholder={placeholder}
      inputMode={inputMode}
      className={className}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

const parseOptionalNumber = (raw: string): number | null => {
  if (!raw) return null;
  const value = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
};

function DirectoryInput({
  value,
  placeholder,
  onChange,
}: {
  value?: string | null;
  placeholder: string;
  onChange: (next: string | null) => void;
}) {
  const { t } = useTranslation();
  const browse = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) onChange(picked);
  };
  return (
    <div className="flex items-center gap-2">
      <CommitInput
        value={value ?? ""}
        placeholder={placeholder}
        className="font-mono text-caption"
        onCommit={(next) => onChange(next || null)}
      />
      <Button
        type="button"
        variant="neutral"
        size="regular"
        className="shrink-0"
        aria-label={t("settings.browse")}
        onClick={() => void browse()}
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="quiet"
        size="regular"
        className="shrink-0"
        aria-label={t("settings.resetDefault")}
        disabled={!value}
        onClick={() => onChange(null)}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const { settings, update } = useSettings();
  const { data: info } = useAppInfo();
  const [importing, setImporting] = useState(false);

  const save = async (patch: Partial<AppSettings>) => {
    try {
      await update(patch);
      // 目录变了：数据来源要重新显示、会话日志要重新扫
      if ("claudeConfigDir" in patch || "codexConfigDir" in patch) {
        await queryClient.invalidateQueries({ queryKey: settingsKeys.appInfo });
      }
      if ("dailyBudgetUsd" in patch || "monthlyBudgetUsd" in patch) {
        await queryClient.invalidateQueries({ queryKey: usageKeys.budget() });
      }
    } catch (error) {
      toast.error(
        t("settings.saveFailed", { error: extractErrorMessage(error) }),
      );
    }
  };

  const changeLanguage = (language: LanguageCode) => {
    void i18n.changeLanguage(language);
    try {
      window.localStorage.setItem("language", language);
    } catch {
      // 忽略
    }
    void save({ language });
  };

  const importHistory = async () => {
    setImporting(true);
    try {
      const result = await settingsApi.importCcSwitchHistory();
      await queryClient.invalidateQueries({ queryKey: usageKeys.all });
      await queryClient.invalidateQueries({ queryKey: settingsKeys.appInfo });
      toast.success(
        t("settings.import.done", {
          detail: result.detailRows,
          days: result.rollupRows,
          skipped: result.detailSkipped + result.rollupDaysSkipped,
        }),
      );
    } catch (error) {
      toast.error(
        t("settings.import.failed", { error: extractErrorMessage(error) }),
      );
    } finally {
      setImporting(false);
    }
  };

  const importPicked = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "SQLite", extensions: ["db", "sqlite"] }],
    });
    if (typeof picked !== "string" || !picked) return;
    setImporting(true);
    try {
      const result = await settingsApi.importCcSwitchHistory(picked);
      await queryClient.invalidateQueries({ queryKey: usageKeys.all });
      await queryClient.invalidateQueries({ queryKey: settingsKeys.appInfo });
      toast.success(
        t("settings.import.done", {
          detail: result.detailRows,
          days: result.rollupRows,
          skipped: result.detailSkipped + result.rollupDaysSkipped,
        }),
      );
    } catch (error) {
      toast.error(
        t("settings.import.failed", { error: extractErrorMessage(error) }),
      );
    } finally {
      setImporting(false);
    }
  };

  const language = (settings?.language ??
    (i18n.resolvedLanguage as LanguageCode) ??
    "en") as LanguageCode;
  const locale = i18n.resolvedLanguage || "en";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<Settings className="h-5 w-5" strokeWidth={1.5} />}
        title={t("nav.settings")}
      />
      <div
        id="main-content"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-stable"
      >
        {!settings ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 py-5">
            <Section title={t("settings.general")}>
              <Row label={t("settings.language")}>
                <SegmentedControl<LanguageCode>
                  size="sm"
                  aria-label={t("settings.language")}
                  value={language}
                  onValueChange={changeLanguage}
                  items={[
                    { value: "zh", label: "简体中文" },
                    { value: "zh-TW", label: "繁體中文" },
                    { value: "en", label: "English" },
                    { value: "ja", label: "日本語" },
                  ]}
                />
              </Row>
              <Row label={t("settings.theme")}>
                <SegmentedControl<"system" | "light" | "dark">
                  size="sm"
                  aria-label={t("settings.theme")}
                  value={theme}
                  onValueChange={setTheme}
                  items={[
                    { value: "system", label: t("settings.themeSystem") },
                    { value: "light", label: t("settings.themeLight") },
                    { value: "dark", label: t("settings.themeDark") },
                  ]}
                />
              </Row>
              <Row
                label={t("settings.launchOnStartup")}
                description={t("settings.launchOnStartupHint")}
              >
                <Switch
                  checked={settings.launchOnStartup}
                  onCheckedChange={(launchOnStartup) =>
                    void save({ launchOnStartup })
                  }
                  aria-label={t("settings.launchOnStartup")}
                />
              </Row>
              <Row
                label={t("settings.showInTray")}
                description={t("settings.showInTrayHint")}
              >
                <Switch
                  checked={settings.showInTray}
                  onCheckedChange={(showInTray) => void save({ showInTray })}
                  aria-label={t("settings.showInTray")}
                />
              </Row>
              <Row label={t("settings.minimizeToTray")}>
                <Switch
                  checked={settings.minimizeToTrayOnClose}
                  disabled={!settings.showInTray}
                  onCheckedChange={(minimizeToTrayOnClose) =>
                    void save({ minimizeToTrayOnClose })
                  }
                  aria-label={t("settings.minimizeToTray")}
                />
              </Row>
              <Row label={t("settings.silentStartup")}>
                <Switch
                  checked={settings.silentStartup}
                  disabled={!settings.showInTray}
                  onCheckedChange={(silentStartup) =>
                    void save({ silentStartup })
                  }
                  aria-label={t("settings.silentStartup")}
                />
              </Row>
            </Section>

            <Section
              title={t("settings.alerts")}
              description={t("settings.alertsHint")}
            >
              <Row
                label={t("settings.dailyBudget")}
                description={t("settings.budgetHint")}
              >
                <CommitInput
                  value={settings.dailyBudgetUsd?.toString() ?? ""}
                  placeholder="$"
                  inputMode="decimal"
                  className="w-[120px] text-end tabular-nums"
                  onCommit={(raw) =>
                    void save({ dailyBudgetUsd: parseOptionalNumber(raw) })
                  }
                />
              </Row>
              <Row label={t("settings.monthlyBudget")}>
                <CommitInput
                  value={settings.monthlyBudgetUsd?.toString() ?? ""}
                  placeholder="$"
                  inputMode="decimal"
                  className="w-[120px] text-end tabular-nums"
                  onCommit={(raw) =>
                    void save({ monthlyBudgetUsd: parseOptionalNumber(raw) })
                  }
                />
              </Row>
              <Row
                label={t("settings.quotaAlert")}
                description={t("settings.quotaAlertHint")}
              >
                <SegmentedControl<string>
                  size="sm"
                  aria-label={t("settings.quotaAlert")}
                  value={String(settings.quotaAlertPercent ?? 0)}
                  onValueChange={(value) =>
                    void save({
                      quotaAlertPercent: value === "0" ? null : Number(value),
                    })
                  }
                  items={[
                    { value: "0", label: t("settings.off") },
                    { value: "50", label: "50%" },
                    { value: "80", label: "80%" },
                    { value: "90", label: "90%" },
                    { value: "95", label: "95%" },
                  ]}
                />
              </Row>
            </Section>

            <Section
              title={t("settings.data")}
              description={t("settings.dataHint")}
            >
              <Row
                label={t("settings.autoScan")}
                description={t("settings.autoScanHint")}
              >
                <Switch
                  checked={settings.sessionAutoSyncEnabled}
                  onCheckedChange={(sessionAutoSyncEnabled) =>
                    void save({ sessionAutoSyncEnabled })
                  }
                  aria-label={t("settings.autoScan")}
                />
              </Row>
              <Row
                label={t("settings.claudeDir")}
                description={t("settings.claudeDirHint")}
                stacked
              >
                <DirectoryInput
                  value={settings.claudeConfigDir}
                  placeholder={info?.claudeDir ?? "~/.claude"}
                  onChange={(claudeConfigDir) => void save({ claudeConfigDir })}
                />
              </Row>
              <Row
                label={t("settings.codexDir")}
                description={t("settings.codexDirHint")}
                stacked
              >
                <DirectoryInput
                  value={settings.codexConfigDir}
                  placeholder={info?.codexDir ?? "~/.codex"}
                  onChange={(codexConfigDir) => void save({ codexConfigDir })}
                />
              </Row>
              <Row
                label={t("settings.import.title")}
                description={
                  info?.ccSwitchImportedAt
                    ? t("settings.import.importedAt", {
                        time: new Date(
                          info.ccSwitchImportedAt * 1000,
                        ).toLocaleString(locale),
                      })
                    : info?.ccSwitchDbExists
                      ? t("settings.import.found", { path: info.ccSwitchDb })
                      : t("settings.import.notFound")
                }
              >
                <div className="flex items-center gap-2">
                  {info?.ccSwitchDbExists && (
                    <Button
                      type="button"
                      variant="neutral"
                      size="regular"
                      disabled={importing}
                      onClick={() => void importHistory()}
                    >
                      {importing && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      {t("settings.import.action")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="quiet"
                    size="regular"
                    disabled={importing}
                    onClick={() => void importPicked()}
                  >
                    {t("settings.import.pick")}
                  </Button>
                </div>
              </Row>
              <Row
                label={t("settings.dataDir")}
                description={
                  <span className="font-mono">{info?.dataDir ?? "…"}</span>
                }
              >
                <Button
                  type="button"
                  variant="neutral"
                  size="regular"
                  onClick={() =>
                    void settingsApi
                      .openDataDir()
                      .catch((error) => toast.error(extractErrorMessage(error)))
                  }
                >
                  {t("settings.openFolder")}
                </Button>
              </Row>
            </Section>

            <Section
              title={t("settings.network")}
              description={t("settings.networkHint")}
            >
              <Row label={t("settings.proxyUrl")} stacked>
                <CommitInput
                  value={settings.networkProxyUrl ?? ""}
                  placeholder="http://127.0.0.1:7890"
                  className="font-mono text-caption"
                  onCommit={(raw) =>
                    void save({ networkProxyUrl: raw || null })
                  }
                />
              </Row>
            </Section>

            <p className="m-0 pb-2 text-center text-caption text-fg-3">
              Pigger Switch {info?.version ?? ""}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
