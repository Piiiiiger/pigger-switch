import { useSettings } from "@/hooks/useSettings";
import { UsageDashboard } from "./UsageDashboard";

interface UsagePageProps {
  /** 点额度条打开订阅额度页 */
  onOpenLimits?: () => void;
  /** 打开设置（数据来源里「修改日志目录」） */
  onOpenSettings?: () => void;
}

/** 用量统计页：读 Claude Code / Codex 的会话日志，不需要任何代理。 */
export function UsagePage({ onOpenLimits, onOpenSettings }: UsagePageProps) {
  const { settings, update } = useSettings();

  return (
    <UsageDashboard
      refreshIntervalMs={settings?.usageDashboardRefreshIntervalMs ?? undefined}
      onRefreshIntervalChange={(usageDashboardRefreshIntervalMs) =>
        update({ usageDashboardRefreshIntervalMs }).then(() => true)
      }
      sessionAutoSyncEnabled={settings?.sessionAutoSyncEnabled ?? true}
      onSessionAutoSyncEnabledChange={(sessionAutoSyncEnabled) =>
        update({ sessionAutoSyncEnabled }).then(() => true)
      }
      onOpenLimits={onOpenLimits}
      onOpenSettings={onOpenSettings}
    />
  );
}
