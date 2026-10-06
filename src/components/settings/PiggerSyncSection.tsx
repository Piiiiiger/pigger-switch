import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useNow } from "@/components/limits/quota";
import { formatRelativeTime } from "@/components/usage/format";
import { piggerSyncApi, type AppSettings } from "@/lib/api/settings";
import { toast } from "@/lib/toast";
import { extractErrorMessage } from "@/utils/errorUtils";
import { CommitInput, Row, Section } from "./SettingsRows";

export const piggerSyncKeys = {
  status: ["pigger-sync", "status"] as const,
};

/** 同步到 Pigger：把用量推到 Pigger 面板的「AI 用量」页 */
export function PiggerSyncSection({
  settings,
  save,
}: {
  settings: AppSettings;
  save: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const now = useNow();
  const [syncing, setSyncing] = useState(false);
  const { data: status } = useQuery({
    queryKey: piggerSyncKeys.status,
    queryFn: piggerSyncApi.status,
    // 推送中勤一点看，平时慢慢跟
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : 10_000),
  });

  const configured = Boolean(settings.piggerUrl && settings.piggerToken);
  const savePigger = async (patch: Partial<AppSettings>) => {
    await save(patch);
    // 改了这几项后台会马上推一遍
    await queryClient.invalidateQueries({ queryKey: piggerSyncKeys.status });
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const outcome = await piggerSyncApi.syncNow();
      toast.success(
        t("settings.pigger.syncDone", {
          rows: outcome.rows,
          sessions: outcome.sessions,
        }),
      );
    } catch (error) {
      toast.error(
        t("settings.pigger.syncFailed", { error: extractErrorMessage(error) }),
      );
    } finally {
      setSyncing(false);
      await queryClient.invalidateQueries({ queryKey: piggerSyncKeys.status });
    }
  };

  const running = syncing || Boolean(status?.running);
  const ago = (at: number) => formatRelativeTime(at * 1000, t, now);
  const statusText = (() => {
    if (running) return t("settings.pigger.syncing");
    if (status?.lastError && status.lastAttemptAt) {
      return t("settings.pigger.failed", {
        time: ago(status.lastAttemptAt),
        error: status.lastError,
      });
    }
    if (status?.lastSuccessAt) {
      return t("settings.pigger.synced", {
        time: ago(status.lastSuccessAt),
        rows: status.lastRows,
        sessions: status.lastSessions,
      });
    }
    return t("settings.pigger.never");
  })();

  return (
    <Section
      title={t("settings.pigger.title")}
      description={t("settings.pigger.hint")}
    >
      <Row
        label={t("settings.pigger.enabled")}
        description={
          configured
            ? t("settings.pigger.enabledHint")
            : t("settings.pigger.needsSetup")
        }
      >
        <Switch
          checked={settings.piggerSyncEnabled}
          disabled={!configured}
          onCheckedChange={(piggerSyncEnabled) =>
            void savePigger({ piggerSyncEnabled })
          }
          aria-label={t("settings.pigger.enabled")}
        />
      </Row>
      <Row
        label={t("settings.pigger.url")}
        description={t("settings.pigger.urlHint")}
        stacked
      >
        <CommitInput
          value={settings.piggerUrl ?? ""}
          placeholder="https://panel.example.com/abc123"
          className="font-mono text-caption"
          aria-label={t("settings.pigger.url")}
          onCommit={(raw) => void savePigger({ piggerUrl: raw || null })}
        />
      </Row>
      <Row
        label={t("settings.pigger.token")}
        description={t("settings.pigger.tokenHint")}
        stacked
      >
        <CommitInput
          value={settings.piggerToken ?? ""}
          type="password"
          className="font-mono text-caption"
          aria-label={t("settings.pigger.token")}
          onCommit={(raw) => void savePigger({ piggerToken: raw || null })}
        />
      </Row>
      <Row
        label={t("settings.pigger.deviceName")}
        description={t("settings.pigger.deviceNameHint")}
      >
        <CommitInput
          value={settings.piggerDeviceName ?? ""}
          placeholder={status?.defaultDeviceName}
          className="w-[200px]"
          aria-label={t("settings.pigger.deviceName")}
          onCommit={(raw) => void savePigger({ piggerDeviceName: raw || null })}
        />
      </Row>
      <Row
        label={t("settings.pigger.status")}
        description={
          <span
            className={
              !running && status?.lastError ? "text-danger-text" : undefined
            }
          >
            {statusText}
          </span>
        }
      >
        <Button
          type="button"
          variant="neutral"
          size="regular"
          disabled={!settings.piggerSyncEnabled || running}
          onClick={() => void syncNow()}
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t("settings.pigger.syncNow")}
        </Button>
      </Row>
    </Section>
  );
}
