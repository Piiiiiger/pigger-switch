import { useSettings } from "@/hooks/useSettings";
import type { AppType } from "@/types/usage";
import { UsageDashboard } from "./UsageDashboard";

interface UsagePageProps {
  tool: AppType;
  /** 点额度条打开订阅额度页 */
  onOpenLimits?: () => void;
  /** 打开设置（数据来源里「修改日志目录」） */
  onOpenSettings?: () => void;
  /** 空状态里「先配好价格」：打开价格页 */
  onOpenPrices?: () => void;
}

/** 一个工具的用量页：读它在本机的会话日志，不需要任何代理。 */
export function UsagePage({
  tool,
  onOpenLimits,
  onOpenSettings,
  onOpenPrices,
}: UsagePageProps) {
  const { settings, update } = useSettings();

  return (
    <UsageDashboard
      tool={tool}
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
      onOpenPrices={onOpenPrices}
    />
  );
}
